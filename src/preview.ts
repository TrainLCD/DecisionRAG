import worker from './index.js';
import type { Env } from './types.js';

/** Only this entrypoint is uploaded for PR previews; production uses index.ts. */
const preview = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    const allowed = request.method === 'GET' && (path === '/health' || path === '/sync/status')
      || request.method === 'POST' && (path === '/search' || path === '/answer');
    if (!allowed) {
      return Response.json({ error: 'preview_read_only' }, {
        status: 403, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
      });
    }
    const response = await worker.fetch!(request as Parameters<NonNullable<typeof worker.fetch>>[0], env, ctx);
    response.headers.set('X-Robots-Tag', 'noindex');
    return response;
  },
} satisfies ExportedHandler<Env>;

// No scheduled or queue handler: previews cannot run background synchronization.
export default preview;
