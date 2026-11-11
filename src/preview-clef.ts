import preview from './preview.js';
import type { Env } from './types.js';

export default {
  ...preview,
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'GET' && new URL(request.url).pathname === '/health') {
      const response = await fetch('https://api.github.com/orgs/' + encodeURIComponent(env.GITHUB_ORG) + '/repos?type=public&per_page=100&page=1', {
        redirect: 'error',
        headers: { Authorization: 'Bearer ' + env.GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'TrainLCD-DecisionRAG' },
      });
      let reason = 'none';
      if (!response.ok) {
        const message = (await response.text()).slice(0, 8000).toLowerCase();
        reason = message.includes('access denied') ? 'access_denied' : message.includes('rate limit') ? 'rate_limit' : message.includes('resource not accessible') ? 'permission' : message.includes('bad credentials') ? 'credentials' : 'other';
      } else await response.body?.cancel();
      return Response.json({ github_status: response.status, reason, remaining: response.headers.get('x-ratelimit-remaining'), reset: response.headers.get('x-ratelimit-reset'), retry_after: response.headers.get('retry-after') }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return preview.fetch(request, { ...env, SCREENING_MODEL: 'clef' }, ctx);
  },
} satisfies ExportedHandler<Env>;
