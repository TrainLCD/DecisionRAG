import { jsonRequest } from './http.js';
import { HttpError, type Env } from './types.js';
export class GitHub {
  constructor(private env: Env) {}
  assertRepo(repo: string): void {
    const [owner, name, extra] = repo.split('/');
    if (owner?.toLowerCase() !== this.env.GITHUB_ORG.toLowerCase() || !name || extra || !/^[\w.-]+$/.test(name))
      throw new HttpError(400, 'repository_out_of_scope');
  }
  async get<T>(path: string): Promise<T> {
    if (!this.env.GITHUB_TOKEN) throw new HttpError(503, 'github_not_configured');
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('..')) throw new HttpError(400, 'invalid_github_path');
    return jsonRequest<T>(`https://api.github.com${path}`, { headers: {
      Authorization: `Bearer ${this.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'TrainLCD-DecisionRAG',
    } }, 8_000_000);
  }
  async all<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const rows = await this.get<T[]>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      items.push(...rows);
      if (rows.length < 100) return items;
    }
    throw new HttpError(422, 'github_pagination_budget_exceeded');
  }
}
export function isDocument(path: string): boolean {
  return !/(^|\/)(node_modules|vendor|\.git|dist|build)\//.test(path) &&
    !/(^|\/)(package-lock|yarn\.lock|pnpm-lock)/.test(path) &&
    /\.(md|mdx|rst|adoc|txt)$/i.test(path);
}
