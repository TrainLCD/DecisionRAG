import { jsonRequest, taggedJsonRequest, type TaggedJson } from './http.js';
import { HttpError, type Env } from './types.js';

interface RepositoryVisibility { full_name: string; private: boolean; visibility: string; disabled?: boolean }
let publicPages: { org: string; token: string; pages: Map<string, TaggedJson<RepositoryVisibility[]>> } | undefined;

export class GitHub {
  constructor(private env: Env) {}
  assertRepo(repo: string): void {
    const [owner, name, extra] = repo.split('/');
    if (owner?.toLowerCase() !== this.env.GITHUB_ORG.toLowerCase() || !name || extra || !/^[\w.-]+$/.test(name))
      throw new HttpError(400, 'repository_out_of_scope');
  }
  /** Make an authenticated request to GitHub without forwarding credentials to redirects. */
  private request<T>(path: string, previous?: TaggedJson<T>): Promise<TaggedJson<T>> {
    if (!this.env.GITHUB_TOKEN) throw new HttpError(503, 'github_not_configured');
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('..')) throw new HttpError(400, 'invalid_github_path');
    return taggedJsonRequest<T>(`https://api.github.com${path}`, { cache: 'no-store', headers: {
      Authorization: `Bearer ${this.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'TrainLCD-DecisionRAG',
    } }, 8_000_000, previous);
  }
  async get<T>(path: string): Promise<T> {
    return (await this.request<T>(path)).value;
  }
  /** Query the Git graph without downloading commit messages or file changes. */
  async graph<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (!this.env.GITHUB_TOKEN) throw new HttpError(503, 'github_not_configured');
    const response = await jsonRequest<{ data?: T; errors?: unknown[] }>('https://api.github.com/graphql', {
      method: 'POST', headers: { Authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json', 'User-Agent': 'TrainLCD-DecisionRAG' },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.data || response.errors?.length) throw new HttpError(502, 'github_graphql_failed');
    return response.data;
  }
  /** Read every page in a collection or report that the pagination budget was exceeded. */
  async all<T>(path: string, getPage = (pagePath: string) => this.get<T[]>(pagePath)): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const rows = await getPage(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      items.push(...rows);
      if (rows.length < 100) return items;
    }
    throw new HttpError(422, 'github_pagination_budget_exceeded');
  }
  /** Revalidate public visibility with GitHub before allowing indexed content to leave the Worker. */
  async publicRepositories(): Promise<string[]> {
    const { GITHUB_ORG: org, GITHUB_TOKEN: token } = this.env;
    const feedbackRepo = `${org.toLowerCase()}/issues`;
    if (publicPages?.org !== org || publicPages.token !== token) publicPages = { org, token, pages: new Map() };
    const { pages } = publicPages;
    const rows = await this.all<RepositoryVisibility>(`/orgs/${encodeURIComponent(org)}/repos?type=public`, async path => {
      const result = await this.request(path, pages.get(path));
      if (!Array.isArray(result.value)) throw new HttpError(502, 'invalid_github_response');
      const value = result.value.map(({ full_name, private: isPrivate, visibility, disabled }) =>
        ({ full_name, private: isPrivate, visibility, disabled }));
      if (result.etag) pages.set(path, { etag: result.etag, value });
      else pages.delete(path);
      return value;
    });
    return rows.filter(repo => repo.private === false && repo.visibility === 'public' && !repo.disabled &&
      repo.full_name.toLowerCase() !== feedbackRepo).map(repo => {
      this.assertRepo(repo.full_name);
      return repo.full_name.toLowerCase();
    });
  }
}
export function isDocument(path: string): boolean {
  return !/(^|\/)(node_modules|vendor|\.git|dist|build)\//.test(path) &&
    !/(^|\/)(package-lock|yarn\.lock|pnpm-lock)/.test(path) &&
    /\.(md|mdx|rst|adoc|txt)$/i.test(path);
}
