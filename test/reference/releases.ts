import type { GitHub } from './github.js';
import { HttpError, type Env } from './types.js';

const latestReleaseQuery = `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    latestRelease { tagName url publishedAt isDraft isPrerelease tagCommit { oid } }
  }
}`;
const historyQuery = `query($owner: String!, $repo: String!, $commit: GitObjectID!, $after: String) {
  repository(owner: $owner, name: $repo) {
    object(oid: $commit) {
      ... on Commit {
        history(first: 100, after: $after) { totalCount nodes { oid } pageInfo { hasNextPage endCursor } }
      }
    }
  }
}`;
interface Release {
  tagName: string; url: string; publishedAt: string | null; isDraft: boolean; isPrerelease: boolean;
  tagCommit: { oid: string } | null;
}
interface History {
  totalCount: number; nodes: { oid: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
const isCommit = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

/** Read the complete ancestry of a pinned release commit, with an explicit size budget. */
async function releaseHistory(gh: GitHub, owner: string, repo: string, commit: string): Promise<string[]> {
  const commits = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < 300; page++) {
    const data: { repository?: { object?: { history?: History } } } =
      await gh.graph(historyQuery, { owner, repo, commit, after });
    const history = data.repository?.object?.history;
    if (!history || !Number.isSafeInteger(history.totalCount) || history.totalCount < 1 || !Array.isArray(history.nodes))
      throw new HttpError(502, 'invalid_github_release_history');
    if (history.totalCount > 30_000) throw new HttpError(422, 'release_history_budget_exceeded');
    for (const node of history.nodes) {
      if (!isCommit(node?.oid)) throw new HttpError(502, 'invalid_github_release_history');
      commits.add(node.oid);
    }
    const { hasNextPage, endCursor } = history.pageInfo;
    if (!hasNextPage) {
      if (commits.size !== history.totalCount || !commits.has(commit)) throw new HttpError(502, 'incomplete_github_release_history');
      return [...commits];
    }
    if (!endCursor || endCursor === after) throw new HttpError(502, 'invalid_github_release_cursor');
    after = endCursor;
  }
  throw new HttpError(422, 'release_history_budget_exceeded');
}

/** Replace the repository's release and commit membership as one versioned snapshot. */
export async function syncRelease(env: Env, gh: GitHub, fullName: string): Promise<void> {
  const checkedAt = new Date().toISOString();
  const [owner, repo] = fullName.split('/');
  const data = await gh.graph<{ repository: { latestRelease: Release | null } | null }>(latestReleaseQuery, { owner, repo });
  if (!data.repository) throw new HttpError(502, 'github_release_repository_unavailable');
  const release = data.repository.latestRelease;
  const published = release && release.isDraft === false && release.isPrerelease === false && release.publishedAt ? release : null;
  const sha = published?.tagCommit?.oid ?? null;
  if (sha !== null && !isCommit(sha)) throw new HttpError(502, 'invalid_github_release_commit');
  const tag = published?.tagName ?? null;
  const url = published?.url ?? null;
  const publishedAt = published?.publishedAt ?? null;
  const previous = await env.DB.prepare('SELECT commit_sha FROM github_releases WHERE repo=?')
    .bind(fullName).first<{ commit_sha: string | null }>();
  if (previous && previous.commit_sha === sha) {
    await env.DB.prepare(`UPDATE github_releases SET tag=?,url=?,published_at=?,checked_at=?,snapshot_id=?
      WHERE repo=? AND commit_sha IS ? AND checked_at<=?`)
      .bind(tag, url, publishedAt, checkedAt, crypto.randomUUID(), fullName, sha, checkedAt).run();
    return;
  }

  const commits = sha ? await releaseHistory(gh, owner!, repo!, sha) : [];
  const snapshotId = crypto.randomUUID();
  const current = 'EXISTS (SELECT 1 FROM github_releases WHERE repo=? AND snapshot_id=?)';
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO github_releases(repo,tag,commit_sha,published_at,url,checked_at,snapshot_id)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM repositories WHERE repo=?)
      ON CONFLICT(repo) DO UPDATE SET tag=excluded.tag,commit_sha=excluded.commit_sha,published_at=excluded.published_at,
        url=excluded.url,checked_at=excluded.checked_at,snapshot_id=excluded.snapshot_id
      WHERE github_releases.checked_at<=excluded.checked_at`)
      .bind(fullName, tag, sha, publishedAt, url, checkedAt, snapshotId, fullName),
    env.DB.prepare(`DELETE FROM github_release_commits WHERE repo=? AND ${current}`).bind(fullName, fullName, snapshotId),
    env.DB.prepare(`INSERT INTO github_release_commits(repo,sha)
      SELECT ?,value FROM json_each(?) WHERE ${current}`).bind(fullName, JSON.stringify(commits), fullName, snapshotId),
  ]);
}
