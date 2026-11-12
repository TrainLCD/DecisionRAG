import { initSync, handle, stream, event } from '../generated/worker/worker.js';
import module from '../generated/worker/worker_bg.wasm';
import { configuration, host } from './host.js';
import type { Env, SyncJob } from './types.js';
initSync({ module });
export function rustWorker(preview = false): ExportedHandler<Env, SyncJob> {
    return {
        async fetch(request, env) {
            const abort = new AbortController();
            const signal = AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(180000)]);
            const config = configuration(env, preview);
            const binding = host(env, { request, signal });
            let result;
            try {
                result = JSON.parse(await handle(JSON.stringify({ method: request.method, path: new URL(request.url).pathname, headers: Object.fromEntries(request.headers) }), config, binding.call));
            }
            catch {
                await binding.close();
                return Response.json({ error: "internal_error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
            }
            await binding.close();
            if (!result.stream) {
                return Response.json(result.body, { status: result.status, headers: { ...result.headers, ...(preview ? { 'X-Robots-Tag': 'noindex' } : {}) } });
            }
            let closed = false;
            const bytes = new TextEncoder();
            const response = new ReadableStream<Uint8Array>({
                start(controller) {
                    const output = host(env, { signal, emit(event, data) { if (!closed && !signal.aborted)
                            controller.enqueue(bytes.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } });
                    void stream(JSON.stringify(result.state), config, output.call).catch(() => {
                        if (!closed && !signal.aborted)
                            controller.enqueue(bytes.encode('event: error\ndata: {"error":"internal_error"}\n\n'));
                    }).finally(async () => { await output.close(); if (!closed) {
                        closed = true;
                        controller.close();
                    } });
                },
                cancel() { closed = true; abort.abort(); },
            });
            return new Response(response, { status: result.status, headers: result.headers });
        },
        async scheduled(_controller, env) { const binding = host(env); try {
            await event(JSON.stringify({ type: 'scheduled' }), configuration(env, preview), binding.call);
        }
        finally {
            await binding.close();
        } },
        async queue(batch, env) { const binding = host(env, { messages: batch.messages }); try {
            await event(JSON.stringify({ type: 'queue', messages: batch.messages.map(m => ({ id: m.id, body: m.body, attempts: m.attempts })) }), configuration(env, preview), binding.call);
        }
        finally {
            await binding.close();
        } },
    };
}
