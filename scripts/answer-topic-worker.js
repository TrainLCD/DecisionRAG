// Ephemeral wrangler remote-development Worker: no routes, D1, or production secrets.
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/health') return Response.json({ ok: true });
    if (path !== '/run' || request.method !== 'POST') return new Response(null, { status: 404 });
    const result = await env.AI.run('@cf/google/gemma-4-26b-a4b-it', await request.json());
    return Response.json(result);
  },
};
