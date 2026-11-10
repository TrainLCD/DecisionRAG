import { GitHub, isDocument } from './github.js';
import { deleteSource, repoRow, saveSource } from './store.js';
import { HttpError, type Env, type Source, type SyncJob } from './types.js';
interface Repository { full_name: string; description: string | null; default_branch: string; archived: boolean; disabled: boolean }
interface Issue { number: number; title: string; body: string | null; html_url: string; updated_at: string;
  state: string; state_reason: string | null; labels: { name: string }[]; pull_request?: unknown; user: { login: string } }
interface Comment { id: number; body: string | null; html_url: string; updated_at?: string; submitted_at?: string; user: { login: string }; path?: string; state?: string; pull_request_review_id?: number }
export async function enqueue(env: Env, job: SyncJob): Promise<void> {
  await env.SYNC_QUEUE.send(job);
}
function discussion(comments: Comment[], label: string): string {
  return comments.map(c => `\n\n## ${label}: ${c.user.login}\n${c.html_url}\n${c.path || ''}\n${c.state || ''}\n${c.body || ''}`).join('');
}
async function saveBounded(env: Env, source: Source, snapshot?: { repo: string; commit: string }): Promise<void> {
  if (new TextEncoder().encode(source.body).length > 600_000) throw new HttpError(422, 'source_size_budget_exceeded');
  await saveSource(env, source, snapshot);
}
export async function sync(env: Env, job: SyncJob): Promise<void> {
  const gh = new GitHub(env);
  if (job.type === 'org') {
    const repos = await gh.get<Repository[]>(`/orgs/${encodeURIComponent(env.GITHUB_ORG)}/repos?per_page=100&page=${job.page}&sort=full_name`);
    for (const repo of repos) {
      gh.assertRepo(repo.full_name);
      if (!repo.disabled) await enqueue(env, { type: 'repo', repo: repo.full_name });
    }
    if (repos.length === 100) await enqueue(env, { type: 'org', page: job.page + 1 });
    return;
  }
  gh.assertRepo(job.repo);
  const prefix = `/repos/${job.repo}`;
  if (job.type === 'repo') {
    const repo = await gh.get<Repository>(prefix);
    await env.DB.prepare(`INSERT INTO repositories(repo,description,default_branch) VALUES(?,?,?)
      ON CONFLICT(repo) DO UPDATE SET description=excluded.description,default_branch=excluded.default_branch`)
      .bind(job.repo, repo.description || '', repo.default_branch).run();
    const row = await env.DB.prepare('SELECT issues_dispatched_at FROM repositories WHERE repo=?')
      .bind(job.repo).first<{ issues_dispatched_at: string | null }>();
    // Overlap makes updates arriving during pagination visible on the next sweep.
    const since = row?.issues_dispatched_at ? new Date(Date.parse(row.issues_dispatched_at) - 600_000).toISOString() : undefined;
    await enqueue(env, { type: 'issues', repo: job.repo, page: 1, ...(since ? { since } : {}), started: new Date().toISOString() });
    await enqueue(env, { type: 'docs', repo: job.repo });
    return;
  }
  if (job.type === 'issues') {
    const rows = await gh.get<Issue[]>(`${prefix}/issues?state=all&sort=updated&direction=asc&per_page=100&page=${job.page}${job.since ? `&since=${encodeURIComponent(job.since)}` : ''}`);
    for (const issue of rows) await enqueue(env, { type: 'issue', repo: job.repo, number: issue.number });
    if (rows.length === 100) await enqueue(env, { ...job, page: job.page + 1 });
    else await env.DB.prepare(`UPDATE repositories SET issues_dispatched_at=? WHERE repo=?
      AND (issues_dispatched_at IS NULL OR issues_dispatched_at<?)`)
      .bind(job.started, job.repo, job.started).run();
    return;
  }
  if (job.type === 'issue') {
    const issue = await gh.get<Issue>(`${prefix}/issues/${job.number}`);
    const comments = await gh.all<Comment>(`${prefix}/issues/${job.number}/comments`);
    let body = `${issue.body || ''}${discussion(comments, 'Comment')}`;
    const metadata: Record<string, unknown> = { number: issue.number, state: issue.state,
      state_reason: issue.state_reason, labels: issue.labels.map(l => l.name), author: issue.user.login,
      // A release is deliberately unknown, regardless of PR merge status.
      release_status: 'unknown' };
    if (issue.pull_request) {
      const pr = await gh.get<{ changed_files: number; merged_at: string | null; merge_commit_sha: string | null; draft: boolean;
        base: { ref: string }; head: { ref: string } }>(`${prefix}/pulls/${job.number}`);
      if (pr.changed_files > 3000) throw new HttpError(422, 'github_changed_files_limit_exceeded');
      const reviews = await gh.all<Comment>(`${prefix}/pulls/${job.number}/reviews`);
      const inline = await gh.all<Comment>(`${prefix}/pulls/${job.number}/comments`);
      const files = await gh.all<{ filename: string; status: string }>(`${prefix}/pulls/${job.number}/files`);
      const pendingReviews = new Set(reviews.filter(review => review.state === 'PENDING').map(review => review.id));
      body += discussion(reviews.filter(review => !pendingReviews.has(review.id)), 'Review') +
        discussion(inline.filter(comment => !pendingReviews.has(comment.pull_request_review_id ?? 0)), 'Inline review') +
        '\n\n## Changed files\n' + files.map(f => `${f.status}: ${f.filename}`).join('\n');
      Object.assign(metadata, { merged_at: pr.merged_at, merge_commit_sha: pr.merge_commit_sha,
        draft: pr.draft, base_branch: pr.base.ref, head_branch: pr.head.ref });
    }
    await saveBounded(env, { id: `${job.repo}#${job.number}`, repo: job.repo,
      kind: issue.pull_request ? 'pr' : job.repo.toLowerCase() === `${env.GITHUB_ORG}/Issues`.toLowerCase() ? 'feedback' : 'issue',
      title: issue.title, url: issue.html_url, body: body || '(No body)', metadata, updated_at: issue.updated_at });
    return;
  }
  const repo = await repoRow(env, job.repo);
  if (!repo) throw new HttpError(503, 'repository_not_synced');
  if (job.type === 'docs') {
    const commit = await gh.get<{ sha: string; commit: { tree: { sha: string } } }>(`${prefix}/commits/${encodeURIComponent(repo.default_branch)}`);
    const tree = await gh.get<{ truncated: boolean; tree: { path: string; type: string; sha: string; size?: number }[] }>(`${prefix}/git/trees/${commit.commit.tree.sha}?recursive=1`);
    if (tree.truncated) throw new HttpError(422, 'github_tree_truncated');
    const docs = tree.tree.filter(f => f.type === 'blob' && isDocument(f.path));
    if (docs.some(d => (d.size || 0) > 600_000)) throw new HttpError(422, 'source_size_budget_exceeded');
    await env.DB.prepare('UPDATE repositories SET docs_commit=? WHERE repo=?').bind(commit.sha, job.repo).run();
    for (const doc of docs) await enqueue(env, { type: 'doc', repo: job.repo, path: doc.path, sha: doc.sha, commit: commit.sha });
    const existing = await env.DB.prepare("SELECT id FROM sources WHERE repo=? AND kind='doc'").bind(job.repo).all<{ id: string }>();
    const keep = new Set(docs.map(d => `${job.repo}:${d.path}`));
    for (const row of existing.results) if (!keep.has(row.id)) await deleteSource(env, row.id);
    return;
  }
  if (repo.docs_commit !== job.commit) return; // Superseded snapshot: do not restore deleted/old docs.
  const blob = await gh.get<{ content: string; encoding: string }>(`${prefix}/git/blobs/${job.sha}`);
  if (blob.encoding !== 'base64') throw new HttpError(502, 'unsupported_blob_encoding');
  const bytes = Uint8Array.from(atob(blob.content.replace(/\s/g, '')), c => c.charCodeAt(0));
  const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  const path = job.path.split('/').map(encodeURIComponent).join('/');
  await saveBounded(env, { id: `${job.repo}:${job.path}`, repo: job.repo, kind: 'doc', title: job.path,
    url: `https://github.com/${job.repo}/blob/${job.commit}/${path}`, body: body || '(Empty document)',
    metadata: { path: job.path, branch: repo.default_branch, commit: job.commit, blob_sha: job.sha }, updated_at: new Date().toISOString() }, { repo: job.repo, commit: job.commit });
}
