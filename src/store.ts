import type { Candidate, Env, Kind, Passage, RepoRow, Source } from './types.js';

// Split by headings/paragraphs first; hard splits keep every character. Never silently
// discard the tail of an issue, discussion or document.
export function splitPassages(body: string, size = 2400): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const paragraph of body.split(/(?=^#{1,6} )|\n\n/um)) {
    if (current && current.length + paragraph.length + 2 > size) {
      pieces.push(current); current = '';
    }
    let rest = paragraph;
    while (rest.length > size) { pieces.push(rest.slice(0, size)); rest = rest.slice(size); }
    if (rest) current += (current ? '\n\n' : '') + rest;
  }
  if (current) pieces.push(current);
  return pieces;
}
export async function saveSource(env: Env, source: Source, snapshot?: { repo: string; commit: string }): Promise<void> {
  // Every statement runs in one D1 transaction. A stale doc job must neither
  // overwrite the source nor erase/restore its passages after snapshot replacement.
  const clause = snapshot ? 'EXISTS(SELECT 1 FROM repositories WHERE repo=? AND docs_commit=?)' : '1=1';
  const guard = snapshot ? [snapshot.repo, snapshot.commit] : [];
  const statements = [env.DB.prepare(`INSERT INTO sources(id,repo,kind,title,url,body,metadata,updated_at)
    SELECT ?,?,?,?,?,?,?,? WHERE ${clause}
    ON CONFLICT(id) DO UPDATE SET repo=excluded.repo,kind=excluded.kind,
    title=excluded.title,url=excluded.url,body=excluded.body,metadata=excluded.metadata,updated_at=excluded.updated_at`)
    .bind(source.id, source.repo, source.kind, source.title, source.url, source.body,
      JSON.stringify(source.metadata), source.updated_at, ...guard),
    env.DB.prepare(`DELETE FROM passages WHERE source_id=? AND ${clause}`).bind(source.id, ...guard)];
  const passages = splitPassages(source.body);
  for (const [i, text] of passages.entries()) statements.push(env.DB.prepare(
    `INSERT INTO passages(id,source_id,ordinal,text) SELECT ?,?,?,? WHERE ${clause}`)
    .bind(`${source.id}:${i}`, source.id, i, text, ...guard));
  await env.DB.batch(statements);
}
export async function deleteSource(env: Env, id: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM passages WHERE source_id=?').bind(id),
    env.DB.prepare('DELETE FROM sources WHERE id=?').bind(id),
  ]);
}
export interface Branch extends Candidate { repo: string; kind: Kind }
export interface SearchScope { publicRepos: string[]; feedbackRepo?: string }
const scopedSources = `((s.kind<>'feedback' AND lower(s.repo) IN (SELECT value FROM json_each(?)))
  OR (s.kind='feedback' AND lower(s.repo)=?))`;

export async function branches(env: Env): Promise<Branch[]> {
  const result = await env.DB.prepare(`SELECT s.repo,s.kind,r.description,count(*) AS count
    FROM sources s JOIN repositories r ON s.repo=r.repo
    GROUP BY s.repo,s.kind ORDER BY s.repo,s.kind`).all<{ repo: string; kind: Kind; description: string; count: number }>();
  return result.results.map(r => ({ id: `${r.repo}/${r.kind}`, repo: r.repo, kind: r.kind,
    description: `${r.repo}: ${r.description}\n${({ issue: 'Engineering issues and discussions',
      pr: 'Pull requests, implementation decisions and reviews', feedback: 'User feedback and bug reports',
      doc: 'Repository documentation and specifications' })[r.kind]} (${r.count} documents)` }));
}
export interface DocumentCursor { branch: Branch; after: string }
export const DOCUMENT_PAGE_SIZE = 540;
export async function documentPages(env: Env, cursors: DocumentCursor[]): Promise<Candidate[][]> {
  const results = await env.DB.batch<{ id: string; title: string; metadata: string }>(cursors.map(({ branch, after }) =>
    env.DB.prepare(`SELECT id,title,metadata FROM sources
      WHERE repo=? AND kind=? AND id>? ORDER BY id LIMIT ?`).bind(branch.repo, branch.kind, after, DOCUMENT_PAGE_SIZE)));
  return results.map(result => result.results.map(r => ({ id: r.id, description: `${r.title}\n${r.metadata}` })));
}
export async function passagesFor(env: Env, ids: string[], scope?: SearchScope): Promise<Passage[]> {
  if (!ids.length) return [];
  // A legacy snapshot can contain a draft review visible only to the sync credential.
  const scopeFilter = scope ? `AND ${scopedSources}
    AND (s.kind<>'pr' OR instr(s.body,char(10)||'PENDING'||char(10))=0)` : '';
  const result = await env.DB.prepare(`SELECT p.*,s.repo,s.kind,s.title,s.url,s.metadata,s.updated_at
    FROM passages p JOIN sources s ON s.id=p.source_id
    WHERE s.id IN (${ids.map(() => '?').join(',')}) ${scopeFilter} ORDER BY s.id,p.ordinal`)
    .bind(...ids, ...(scope ? [JSON.stringify(scope.publicRepos), scope.feedbackRepo ?? null] : []))
    .all<Omit<Passage, 'metadata'> & { metadata: string }>();
  return result.results.map(p => ({ ...p, metadata: JSON.parse(p.metadata) as Record<string, unknown> }));
}
export async function repoRow(env: Env, repo: string): Promise<RepoRow | null> {
  return env.DB.prepare('SELECT * FROM repositories WHERE repo=?').bind(repo).first<RepoRow>();
}
