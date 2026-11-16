// Evaluation-only version entry. Never routed to production. No DB access.
// A short-lived random bearer is generated and masked by the evaluation job.
interface EvaluationEnv { EVALUATION_TOKEN: string; EVALUATION_EXPIRES: string; TYPESAFE_API_KEY: string }
export default {
  async queue() { throw new Error("Evaluation versions cannot consume queues"); },
  async scheduled() { throw new Error("Evaluation versions cannot synchronize sources"); },
  async fetch(request: Request, env: EvaluationEnv): Promise<Response> {
    const expires = Number(env.EVALUATION_EXPIRES);
    if (!env.EVALUATION_TOKEN || !Number.isFinite(expires) || Date.now() >= expires
      || request.headers.get('authorization') !== `Bearer ${env.EVALUATION_TOKEN}`) return new Response(null, { status: 403 });
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/judge') return new Response(null, { status: 404 });
    const reader = request.body?.getReader();
    if (!reader) return new Response(null, { status: 400 });
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 24000) return new Response(null, { status: 413 }); chunks.push(value); }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const raw = new Uint8Array(size); let offset = 0; for (const c of chunks) { raw.set(c, offset); offset += c.length; }
    let body: any; try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return new Response(null, { status: 400 }); }
    if (body.model !== 'jev-1.14.0' || !body.questions || Object.values<any>(body.questions).some(q => q.type !== 'noul')) return new Response(null, { status: 400 });
    try {
      const upstream = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(25000), headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' }, body: raw });
      if (!upstream.ok) return new Response('evaluation_provider_error', { status: upstream.status >= 300 && upstream.status < 400 ? 502 : upstream.status, headers: { 'Retry-After': upstream.headers.get('retry-after') ?? '1', 'Cache-Control': 'no-store' } });
      return new Response(upstream.body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    } catch { return new Response('evaluation_provider_unavailable', { status: 503 }); }
  },
};
