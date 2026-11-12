// Cloudflare/Web API bindings only. Routing, authentication, SQL, sync jobs,
// inference, generation parsing and response policy live in backend/src/*.rs.
import type { Env, SyncJob } from './types.js';
type Emit = (event: string, data: unknown) => void;
type Input = Record<string, any>;
class HostError extends Error {
    constructor(readonly status: number, readonly code: string) { super(code); }
}
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let stop: () => void = () => { };
    try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
                stop = () => reject(new HostError(502, 'upstream_timeout'));
                signal.addEventListener('abort', stop, { once: true });
            })]);
    }
    finally {
        signal.removeEventListener('abort', stop);
    }
}
async function readText(body: ReadableStream<Uint8Array> | null, max: number, signal: AbortSignal): Promise<string> {
    if (!body)
        return '';
    const reader = body.getReader(), decoder = new TextDecoder();
    let size = 0, text = '';
    try {
        for (;;) {
            const part = await abortable(reader.read(), signal);
            if (part.done)
                return text + decoder.decode();
            size += part.value.byteLength;
            if (size > max)
                throw new HostError(413, 'upstream_body_too_large');
            text += decoder.decode(part.value, { stream: true });
        }
    }
    finally {
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
export function configuration(env: Env, preview: boolean) {
    return JSON.stringify({ api_token: env.API_TOKEN ?? '', webhook_secret: env.WEBHOOK_SECRET ?? '', github_token: env.GITHUB_TOKEN ?? '', github_org: env.GITHUB_ORG ?? '',
        answer_api_key: env.ANSWER_API_KEY ?? '', answer_model: env.ANSWER_MODEL ?? '', answer_base_url: env.ANSWER_BASE_URL ?? '',
        max_screened_documents: env.MAX_SCREENED_DOCUMENTS ?? null, support_threshold: env.SUPPORT_THRESHOLD ?? null, conflict_threshold: env.CONFLICT_THRESHOLD ?? null, ai: !!env.AI, preview });
}
export function host(env: Env, options: {
    request?: Request;
    signal?: AbortSignal;
    emit?: Emit;
    messages?: readonly Message<SyncJob>[];
} = {}) {
    const signal = options.signal ?? (AbortSignal.timeout(options.messages ? 720000 : 180000));
    let jobIndex = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let decoder = new TextDecoder();
    const setStream = (body: ReadableStream<Uint8Array> | null) => {
        if (!body)
            throw new HostError(502, 'generation_unavailable');
        reader = body.getReader();
        decoder = new TextDecoder();
    };
    const invoke = async (op: string, input: any): Promise<unknown> => {
        // Queue bookkeeping must still run after an upstream/request deadline.
        if (!options.messages || !['db', 'batch', 'ack', 'retry', 'checkpoint', 'job_start'].includes(op)) signal.throwIfAborted();
        switch (op) {
            case 'job_start': jobIndex = input; return null;
            case 'checkpoint': {
                const message = options.messages?.[jobIndex];
                if (!message) throw new HostError(503, 'missing_sync_message');
                await env.DB.prepare('UPDATE sync_jobs SET job=? WHERE id=?').bind(JSON.stringify(input), message.id).run();
                return null;
            }
            case 'request_text': return readText(options.request?.body ?? null, input, signal);
            case 'db': return (await env.DB.prepare(input.sql).bind(...input.params).all()).results;
            case 'batch': return (await env.DB.batch(input.map((s: Input) => env.DB.prepare(s.sql).bind(...s.params)))).map(r => r.results);
            case 'queue':
                await env.SYNC_QUEUE.send(input);
                return null;
            case 'rate_limit': {
                if (!env.PUBLIC_SEARCH_RATE_LIMIT)
                    throw new HostError(503, 'public_search_unavailable');
                return env.PUBLIC_SEARCH_RATE_LIMIT.limit({ key: input });
            }
            case 'random': return [...crypto.getRandomValues(new Uint8Array(input))];
            case 'uuid': return crypto.randomUUID();
            case 'ack':
                options.messages?.[input]?.ack();
                return null;
            case 'retry':
                options.messages?.[input.index]?.retry({ delaySeconds: input.delaySeconds });
                return null;
            case 'emit':
                options.emit?.(input.event, input.data);
                return null;
            case 'fetch': {
                const deadline = AbortSignal.any([signal, AbortSignal.timeout(input.timeout_ms)]);
                let response: Response;
                try {
                    response = await abortable(fetch(input.url, { method: input.method, headers: input.headers, body: input.body === null ? undefined : JSON.stringify(input.body), redirect: 'manual', signal: deadline }), deadline);
                }
                catch (error) {
                    if (error instanceof HostError)
                        throw error;
                    throw new HostError(502, deadline.aborted ? 'upstream_timeout' : 'upstream_network_error');
                }
                return { status: response.status, headers: Object.fromEntries(response.headers), body: await readText(response.body, input.max_bytes, deadline) };
            }
            case 'fetch_stream': {
                let response: Response;
                try {
                    response = await abortable(fetch(input.url, { method: 'POST', headers: input.headers, body: JSON.stringify(input.body), redirect: 'manual', signal }), signal);
                }
                catch (error) {
                    if (error instanceof HostError)
                        throw error;
                    throw new HostError(502, signal.aborted ? 'upstream_timeout' : 'upstream_network_error');
                }
                if (response.ok)
                    setStream(response.body);
                else
                    await response.body?.cancel();
                return { status: response.status };
            }
            case 'ai':
            case 'ai_stream': {
                if (!env.AI)
                    throw new HostError(503, 'generation_unavailable');
                const result = await abortable(env.AI.run(input.model, input.input, { signal }) as Promise<unknown>, signal);
                if (op === 'ai_stream') {
                    setStream(result as ReadableStream<Uint8Array>);
                    return null;
                }
                return result;
            }
            case 'stream_read': {
                if (!reader)
                    throw new HostError(502, 'generation_unavailable');
                const part = await abortable(reader.read(), signal);
                return { done: part.done, text: part.done ? decoder.decode() : decoder.decode(part.value, { stream: true }) };
            }
            case 'stream_cancel':
                if (reader) {
                    await reader.cancel().catch(() => { });
                    reader.releaseLock();
                    reader = undefined;
                }
                return null;
            default: throw new HostError(503, 'unknown_host_operation');
        }
    };
    const call = async (op: string, input: string): Promise<string> => {
        try {
            return JSON.stringify({ value: await invoke(op, JSON.parse(input)) });
        }
        catch (error) {
            return JSON.stringify({ status: error instanceof HostError ? error.status : 503, error: error instanceof HostError ? error.code : 'host_operation_failed' });
        }
    };
    return { call, async close() { if (reader) {
            await reader.cancel().catch(() => { });
            reader.releaseLock();
            reader = undefined;
        } } };
}

