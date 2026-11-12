import worker from './index.js';
import { evaluationSnapshot } from './evaluation.js';
import type { Env } from './types.js';

/** Only this entrypoint is uploaded for PR previews; production uses index.ts. */
const preview = {
  // Cloudflare requires these exports while the existing Worker has triggers.
  // Fail without acknowledging queue messages or touching production resources.
  async queue() { throw new Error('preview_read_only'); },
  async scheduled() { throw new Error('preview_read_only'); },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    // The comparison is opt-in and limited to this read-only preview entrypoint.
    const passageModel = url.searchParams.get('passage_model');
    if (passageModel !== null && passageModel !== 'clef' && passageModel !== 'clef-flash')
      return Response.json({ error: 'invalid_passage_model' }, { status: 400 });
    const evaluationEnv = { ...env, PASSAGE_MODEL: passageModel ?? 'clef' } as Env;
    if (path === '/evaluation/revision' && request.method === 'GET') {
      try {
        return Response.json(await evaluationSnapshot(env), { headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
      } catch {
        return Response.json({ error: 'evaluation_snapshot_unavailable' }, { status: 503 });
      }
    }
    const allowed = request.method === 'GET' && (path === '/health' || path === '/sync/status')
      || request.method === 'POST' && (path === '/search' || path === '/answer');
    if (!allowed) {
      return Response.json({ error: 'preview_read_only' }, {
        status: 403, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
      });
    }
    const response = await worker.fetch!(request as Parameters<NonNullable<typeof worker.fetch>>[0], evaluationEnv, ctx);
    response.headers.set('X-Robots-Tag', 'noindex');
    return response;
  },
} satisfies ExportedHandler<Env>;

// Trigger handlers intentionally reject instead of running synchronization.
export default preview;
