import { Marked } from 'marked';
import { answer } from './answer.js';
import { GitHub } from './github.js';
import { readText } from './http.js';
import { Jev } from './jev.js';
import { DEFAULT_BUDGETS, d1Store, retrieve } from './retrieval.js';
import { enqueue, sync } from './sync.js';
import { boundedNumber, HttpError, type Env, type SyncJob } from './types.js';
import { purgeRepo, secureEqual, webhook } from './webhook.js';

const markdown = new Marked({ gfm: true, renderer: { html: () => '' } });

function passageHtml(text: string): string | undefined {
  try {
    return markdown.parse(text, { async: false }).trim() || undefined;
  } catch {
    // Keep the original passage available if Markdown parsing fails.
    return undefined;
  }
}

async function bodyJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'json_required');
  try {
    const parsed: unknown = JSON.parse(await readText(new Response(request.body), 16_000));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'invalid_json'); }
}
/** Enforce the configured Bearer credential for private or administrative operations. */
async function requireToken(request: Request, env: Env): Promise<void> {
  if (!env.API_TOKEN) throw new HttpError(503, 'authentication_not_configured');
  if (!await secureEqual(request.headers.get('authorization') || '', `Bearer ${env.API_TOKEN}`)) throw new HttpError(401, 'unauthorized');
}

/** Search within the caller's allowed scope and record server-side phase timings. */
async function search(request: Request, env: Env, path: string): Promise<Response> {
  const body = await bodyJson(request);
  if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 1500) throw new HttpError(400, 'query_must_be_1_to_1500_characters');
  if (body.include_feedback !== undefined && typeof body.include_feedback !== 'boolean')
    throw new HttpError(400, 'invalid_feedback_scope');

  const hasToken = request.headers.has('authorization');
  if (hasToken || body.include_feedback === true) await requireToken(request, env);
  const start = Date.now();
  if (!hasToken) {
    if (!env.PUBLIC_SEARCH_RATE_LIMIT) throw new HttpError(503, 'public_search_unavailable');
    const { success } = await env.PUBLIC_SEARCH_RATE_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    if (!success) throw new HttpError(429, 'public_search_rate_limited');
  }
  const maxDocuments = boundedNumber(env.MAX_SCREENED_DOCUMENTS, 20_000, 1, 100_000);
  // Existing Bearer callers that omit the scope retain their authenticated search.
  const timings = { scope_ms: 0, storage_ms: 0, model_ms: 0, generation_ms: 0, retrieval_ms: 0 };
  const scopeStart = Date.now();
  const scope = hasToken && body.include_feedback === undefined ? undefined : new GitHub(env).publicRepositories().then(publicRepos => {
    timings.scope_ms = Date.now() - scopeStart;
    return { publicRepos, feedbackRepo: body.include_feedback ? `${env.GITHUB_ORG.toLowerCase()}/issues` : undefined };
  });
  const query = body.query.trim();
  const judge = new Jev(env);
  const { evidence, hitCount } = await retrieve(query, d1Store(env, scope, timings), judge, { ...DEFAULT_BUDGETS, maxDocuments });
  timings.retrieval_ms = Date.now() - start;
  const excerpts = evidence.map(item => ({ ...item, text_html: passageHtml(item.text) }));
  const finish = (result: object) => {
    for (const step of judge.trace) {
      if (step.stage === 'generate_answer') timings.generation_ms += step.elapsed_ms;
      else timings.model_ms += step.elapsed_ms;
    }
    return { ...result, evidence: excerpts, hit_count: hitCount, trace: judge.trace, timings, elapsed_ms: Date.now() - start,
      retrieval: 'hierarchical_decision', release_inference: 'github_release_commit_ancestry' };
  };
  if (path === '/answer' && request.headers.get('accept')?.includes('text/event-stream')) {
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, request.signal, AbortSignal.timeout(180_000)]);
    const encoder = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: unknown) => {
          if (!closed && !signal.aborted) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        send('sources', { evidence: excerpts, hit_count: hitCount, elapsed_ms: Date.now() - start });
        void (async () => {
          try {
            const result = await answer(query, evidence, env, judge, draft => send('draft', draft), signal);
            send('result', finish(result));
          } catch (error) {
            send('error', { error: error instanceof HttpError ? error.message : 'generation_unavailable' });
          } finally {
            if (!closed) { closed = true; controller.close(); }
          }
        })();
      },
      cancel() { closed = true; abort.abort(); },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  const result = path === '/answer' ? await answer(query, evidence, env, judge) : { status: evidence.length ? 'retrieved' : 'empty' };
  return Response.json(finish(result));
}

/** Dispatch public endpoints before applying the authentication gate for admin routes. */
async function route(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === '/health' && request.method === 'GET') return Response.json({ ok: true });
  if (path === '/webhooks/github' && request.method === 'POST') return webhook(request, env);
  if ((path === '/search' || path === '/answer') && request.method === 'POST') return search(request, env, path);
  await requireToken(request, env);
  if (path === '/sync' && request.method === 'POST') {
    await enqueue(env, { type: 'org', page: 1 });
    return Response.json({ status: 'queued' }, { status: 202 });
  }
  if (path === '/sync/status' && request.method === 'GET') {
    const [jobs, sources, repos, errors] = await Promise.all([
      env.DB.prepare('SELECT status,count(*) AS count FROM sync_jobs GROUP BY status').all(),
      env.DB.prepare('SELECT repo,kind,count(*) AS count,max(updated_at) AS latest_source_update FROM sources GROUP BY repo,kind').all(),
      env.DB.prepare('SELECT * FROM repositories ORDER BY repo').all(),
      env.DB.prepare("SELECT id,job,status,error,updated_at FROM sync_jobs WHERE status IN ('failed','retrying') ORDER BY updated_at DESC LIMIT 20").all(),
    ]);
    return Response.json({ jobs: jobs.results, sources: sources.results, repositories: repos.results, errors: errors.results });
  }
  if (path === '/admin/purge' && request.method === 'POST') {
    const body = await bodyJson(request);
    if (typeof body.repo !== 'string') throw new HttpError(400, 'repository_required');
    new GitHub(env).assertRepo(body.repo);
    await purgeRepo(env, body.repo);
    return Response.json({ purged: body.repo });
  }
  throw new HttpError(404, 'not_found');
}
const worker: ExportedHandler<Env, SyncJob> = {
  /** Handle HTTP errors without exposing upstream payloads or credentials. */
  async fetch(request, env) {
    try {
      const response = await route(request, env);
      response.headers.set('Cache-Control', 'no-store');
      response.headers.set('X-Content-Type-Options', 'nosniff');
      return response;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const code = e instanceof HttpError ? e.code : 'internal_error';
      console.error(JSON.stringify({ event: 'request_error', status, code }));
      return Response.json({ error: code }, { status, headers: { 'Cache-Control': 'no-store',
        ...(code === 'public_search_rate_limited' ? { 'Retry-After': '60' } : {}) } });
    }
  },
  async scheduled(_controller, env) { await enqueue(env, { type: 'org', page: 1 }); },
  async queue(batch, env) {
    for (const message of batch.messages) {
      const now = new Date().toISOString();
      await env.DB.prepare(`INSERT INTO sync_jobs(id,job,status,updated_at) VALUES(?,?,'running',?)
        ON CONFLICT(id) DO UPDATE SET status='running',updated_at=excluded.updated_at,error=NULL`)
        .bind(message.id, JSON.stringify(message.body), now).run();
      try {
        await sync(env, message.body);
        await env.DB.prepare("UPDATE sync_jobs SET status='completed',updated_at=?,error=NULL WHERE id=?")
          .bind(new Date().toISOString(), message.id).run();
        message.ack();
      } catch (e) {
        const code = e instanceof HttpError ? e.code : 'sync_error';
        await env.DB.prepare('UPDATE sync_jobs SET status=?,updated_at=?,error=? WHERE id=?')
          .bind(message.attempts >= 6 ? 'failed' : 'retrying', new Date().toISOString(), code, message.id).run();
        console.error(JSON.stringify({ event: 'sync_error', type: message.body.type, code, attempts: message.attempts }));
        message.retry({ delaySeconds: Math.min(3600, 30 * 2 ** Math.min(message.attempts, 6)) });
      }
    }
    await env.DB.prepare("DELETE FROM sync_jobs WHERE status='completed' AND updated_at<datetime('now','-7 days')").run();
  },
};
export default worker;

