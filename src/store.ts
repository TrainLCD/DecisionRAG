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
/** Load scoped titles together so small collections can skip repository routing. */
export async function documentsFor(env: Env, limit: number, scope?: SearchScope): Promise<Candidate[]> {
  const result = await env.DB.prepare(`SELECT s.id,s.kind,s.title,s.metadata,
      CASE WHEN s.kind='doc' THEN substr(s.body,1,140) ELSE '' END AS introduction,
      substr(s.body,1,60)||' … '||substr(s.body,max(1,length(s.body)/2-20),40)||' … '||substr(s.body,-40) AS sample
    FROM sources s JOIN repositories r ON s.repo=r.repo ${scope ? `WHERE ${scopedSources}` : 'WHERE 1=1'}
      AND (s.kind<>'pr' OR instr(s.body,char(10)||'PENDING'||char(10))=0)
    ORDER BY s.repo,s.kind,s.id LIMIT ?`)
    .bind(...(scope ? [JSON.stringify(scope.publicRepos), scope.feedbackRepo ?? null] : []), limit)
    .all<{ id: string; kind: Kind; title: string; metadata: string; introduction: string; sample: string }>();
  return result.results.map(({ id, kind, title, metadata, introduction, sample }) => ({
    id, references: localReferences(id, sample), overview: `${title} (${kind})\n${sample}`, description: `${title}\n${id} (${kind})\n${metadata}\nBody excerpts: ${sample}${introduction ? '\n' + introduction : ''}`,
  }));
}
/** Advance each branch's document cursor in one D1 round trip. */
export async function documentPages(env: Env, cursors: DocumentCursor[]): Promise<Candidate[][]> {
  const results = await env.DB.batch<{ id: string; title: string; metadata: string; sample: string }>(cursors.map(({ branch, after }) =>
    env.DB.prepare(`SELECT id,title,metadata,substr(body,1,60)||' … '||substr(body,max(1,length(body)/2-20),40)||' … '||substr(body,-40) AS sample FROM sources
      WHERE repo=? AND kind=? AND id>? AND (kind<>'pr' OR instr(body,char(10)||'PENDING'||char(10))=0) ORDER BY id LIMIT ?`).bind(branch.repo, branch.kind, after, DOCUMENT_PAGE_SIZE)));
  return results.map(result => result.results.map(r => ({ id: r.id, references: localReferences(r.id, r.sample), overview: `${r.title}\n${r.sample}`, description: `${r.title}\n${r.metadata}\nBody excerpts: ${r.sample}` })));
}
/** Load passage text after reapplying the search scope to the selected sources. */
export async function passagesFor(env: Env, ids: string[], limit: number, scope?: SearchScope): Promise<Passage[]> {
  if (!ids.length) return [];
  // A legacy snapshot can contain a draft review visible only to the sync credential.
  const scopeFilter = scope ? `AND ${scopedSources}
    AND (s.kind<>'pr' OR instr(s.body,char(10)||'PENDING'||char(10))=0)` : '';
  const result = await env.DB.prepare(`SELECT p.*,s.repo,s.kind,s.title,s.url,s.metadata,s.updated_at,
      r.tag AS release_tag,r.url AS release_url,r.published_at AS release_published_at
    FROM passages p JOIN sources s ON s.id=p.source_id
    LEFT JOIN github_release_commits c ON s.kind='pr' AND json_extract(s.metadata,'$.merged_at') IS NOT NULL
      AND c.repo=s.repo AND c.sha=json_extract(s.metadata,'$.merge_commit_sha')
    LEFT JOIN github_releases r ON r.repo=c.repo
    WHERE s.id IN (SELECT value FROM json_each(?)) ${scopeFilter} ORDER BY s.id,p.ordinal LIMIT ?`)
    .bind(JSON.stringify(ids), ...(scope ? [JSON.stringify(scope.publicRepos), scope.feedbackRepo ?? null] : []), limit)
    .all<Omit<Passage, 'metadata'> & { metadata: string; release_tag: string | null; release_url: string | null; release_published_at: string | null }>();
  return result.results.map(({ release_tag, release_url, release_published_at, ...p }) => {
    const metadata = JSON.parse(p.metadata) as Record<string, unknown>;
    if (release_tag && release_url && release_published_at) {
      metadata.release_status = 'included_in_github_release';
      metadata.github_release = { tag: release_tag, url: release_url, published_at: release_published_at };
    }
    return { ...p, metadata };
  });
}
export async function repoRow(env: Env, repo: string): Promise<RepoRow | null> {
  return env.DB.prepare('SELECT * FROM repositories WHERE repo=?').bind(repo).first<RepoRow>();
}


/** Resolve explicit same-repository issue references; callers intersect them with scoped sources. */
export function localReferences(id: string, text: string): string[] {
  const repo = id.split(/[#:]/u)[0]!;
  return [...new Set([...text.matchAll(/(?<![\w/])#([1-9][0-9]*)\b/gu)].map(match => `${repo}#${match[1]}`))];
}
