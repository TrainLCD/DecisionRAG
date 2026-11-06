import { readText } from './http.js';
import { GitHub } from './github.js';
import { deleteSource } from './store.js';
import { enqueue } from './sync.js';
import { HttpError, type Env } from './types.js';
export async function secureEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [aa, bb] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(a)), crypto.subtle.digest('SHA-256', encoder.encode(b))]);
  const left = new Uint8Array(aa), right = new Uint8Array(bb);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!;
  return difference === 0;
}
export async function verifySignature(secret: string, body: string, signature: string | null): Promise<boolean> {
  if (!secret || !signature || !/^sha256=[a-f\d]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  const expected = 'sha256=' + [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  return secureEqual(expected, signature);
}
export async function webhook(request: Request, env: Env): Promise<Response> {
  const body = await readText(new Response(request.body), 2_000_000);
  if (!await verifySignature(env.WEBHOOK_SECRET, body, request.headers.get('x-hub-signature-256')))
    throw new HttpError(401, 'invalid_webhook_signature');
  let payload: { action?: string; repository?: { full_name: string }; issue?: { number: number }; pull_request?: { number: number }; number?: number; deleted?: boolean };
  try { payload = JSON.parse(body) as typeof payload; } catch { throw new HttpError(400, 'invalid_json'); }
  const event = request.headers.get('x-github-event');
  if (event === 'ping') return Response.json({ ok: true });
  const repo = payload.repository?.full_name;
  if (!repo) throw new HttpError(400, 'missing_repository');
  new GitHub(env).assertRepo(repo);
  if (event === 'repository' && ['deleted', 'transferred'].includes(payload.action || '')) {
    await purgeRepo(env, repo);
  } else if (event === 'repository') {
    await enqueue(env, { type: 'repo', repo });
  } else if (['issues', 'issue_comment', 'pull_request', 'pull_request_review', 'pull_request_review_comment'].includes(event || '')) {
    const number = payload.issue?.number || payload.pull_request?.number || payload.number;
    if (!Number.isSafeInteger(number) || number! < 1) throw new HttpError(400, 'invalid_issue_number');
    if (event === 'issues' && ['deleted', 'transferred'].includes(payload.action || '')) await deleteSource(env, `${repo}#${number}`);
    else await enqueue(env, { type: 'issue', repo, number: number! });
  } else if (event === 'push') {
    await enqueue(env, { type: 'repo', repo });
  }
  // Delivery retries can enqueue twice; latest-state fetches and upserts are idempotent.
  return Response.json({ accepted: true }, { status: 202 });
}
export async function purgeRepo(env: Env, repo: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM passages WHERE source_id IN (SELECT id FROM sources WHERE repo=?)').bind(repo),
    env.DB.prepare('DELETE FROM sources WHERE repo=?').bind(repo),
    env.DB.prepare('DELETE FROM repositories WHERE repo=?').bind(repo),
  ]);
}
