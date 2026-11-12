import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sync, webhook } from './rust-services.js';
import { passagesFor, saveSource } from './reference/store.js';
import { verifySignature } from './reference/webhook.js';
import worker from '../src/index.js';
import { fixture, mockFetch } from './helpers.js';

const issue = { number: 1, title: '報告', body: '測位が止まる', html_url: 'https://github.com/TrainLCD/Issues/issues/1', updated_at: '2026-11-06T00:00:00Z', state: 'open', state_reason: null, labels: [{ name: 'bug' }], user: { login: 'reporter' } };
test('feedback remains one source across updates, including paginated discussion', async () => {
  const { env, sqlite } = fixture();
  const restore = mockFetch(url => {
    if (url.includes('/comments')) return Response.json([{ id: 1, body: '追加報告', html_url: issue.html_url + '#issuecomment-1', user: { login: 'reporter' } }]);
    return Response.json(issue);
  });
  try {
    await sync(env, { type: 'issue', repo: 'TrainLCD/Issues', number: 1 });
    await sync(env, { type: 'issue', repo: 'TrainLCD/Issues', number: 1 });
    const row = sqlite.prepare('SELECT kind,body,metadata FROM sources').get();
    assert.equal(row?.kind, 'feedback'); assert.match(String(row?.body), /追加報告/);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM sources').get()?.n, 1);
    assert.equal(JSON.parse(String(row?.metadata)).release_status, 'unknown');
  } finally { restore(); sqlite.close(); }
});

test('PR ingestion retains reviews, file changes, merge scope and unknown release status', async () => {
  const { env, sqlite } = fixture();
  const restore = mockFetch(url => {
    if (url.includes('/issues/1/comments')) return Response.json([]);
    if (url.includes('/issues/1')) return Response.json({ ...issue, pull_request: {}, html_url: 'https://github.com/TrainLCD/MobileApp/pull/1' });
    if (url.includes('/reviews')) return Response.json([
      { id: 2, body: 'Only for dev', state: 'APPROVED', user: { login: 'reviewer' }, html_url: issue.html_url },
      { id: 3, body: 'Pending draft', state: 'PENDING', user: { login: 'reviewer' }, html_url: issue.html_url },
    ]);
    if (url.includes('/comments')) return Response.json([
      { id: 4, body: 'Pending inline draft', pull_request_review_id: 3, user: { login: 'reviewer' }, html_url: issue.html_url },
    ]);
    if (url.includes('/files')) return Response.json([{ filename: 'src/heartbeat.ts', status: 'modified' }]);
    return Response.json({ merged_at: '2026-11-06', merge_commit_sha: 'abc', draft: false, base: { ref: 'dev' }, head: { ref: 'fix' } });
  });
  try {
    await sync(env, { type: 'issue', repo: 'TrainLCD/MobileApp', number: 1 });
    const row = sqlite.prepare('SELECT * FROM sources').get();
    assert.equal(row?.kind, 'pr'); assert.match(String(row?.body), /Only for dev/); assert.match(String(row?.body), /heartbeat.ts/);
    assert.doesNotMatch(String(row?.body), /Pending .*draft|Pending draft/);
    const metadata = JSON.parse(String(row?.metadata));
    assert.equal(metadata.base_branch, 'dev'); assert.equal(metadata.release_status, 'unknown');
  } finally { restore(); sqlite.close(); }
});

test('a published GitHub release is linked only to merged PRs whose commits it contains', async () => {
  const { env, sqlite } = fixture();
  const repo = 'TrainLCD/MobileApp';
  const tip = 'a'.repeat(40), ancestor = 'b'.repeat(40), missing = 'c'.repeat(40);
  sqlite.prepare('INSERT INTO repositories(repo,description,default_branch) VALUES(?,?,?)').run(repo, 'app', 'main');
  const sources = [
    { sha: ancestor, merged: '2026-11-03', kind: 'pr' },
    { sha: missing, merged: '2026-11-03', kind: 'pr' },
    { sha: ancestor, merged: null, kind: 'pr' },
    { sha: ancestor, merged: '2026-11-03', kind: 'issue' },
  ] as const;
  for (const [i, source] of sources.entries()) await saveSource(env, { id: `${repo}#${i}`, repo, kind: source.kind,
    title: `Source ${i}`, url: `https://github.com/${repo}/pull/${i}`, body: 'source text', updated_at: '2026-11-04',
    metadata: { merged_at: source.merged, merge_commit_sha: source.sha, release_status: 'unknown' } });
  const ids = sources.map((_, i) => `${repo}#${i}`);
  const publishedAt = '2026-11-06T00:00:00Z';
  const url = `https://github.com/${repo}/releases/tag/v1.2.3`;
  let published = true;
  let historyCalls = 0;
  const restore = mockFetch((endpoint, init) => {
    assert.equal(endpoint, 'https://api.github.com/graphql');
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes('latestRelease')) return Response.json({ data: { repository: {
      latestRelease: published ? { tagName: 'v1.2.3', url, publishedAt, isDraft: false,
        isPrerelease: false, tagCommit: { oid: tip } } : null,
    } } });
    historyCalls++;
    assert.equal(variables.commit, tip);
    const first = variables.after === null;
    return Response.json({ data: { repository: { object: { history: { totalCount: 2,
      nodes: [{ oid: first ? tip : ancestor }], pageInfo: { hasNextPage: first, endCursor: first ? 'next' : null },
    } } } } });
  });
  try {
    await sync(env, { type: 'releases', repo });
    await sync(env, { type: 'releases', repo });
    assert.equal(historyCalls, 2);
    const passages = await passagesFor(env, ids, 10);
    assert.equal(passages[0]?.metadata.release_status, 'included_in_github_release');
    assert.deepEqual(passages[0]?.metadata.github_release, { tag: 'v1.2.3', url, published_at: publishedAt });
    assert.deepEqual(passages.slice(1).map(passage => passage.metadata.release_status), ['unknown', 'unknown', 'unknown']);
    published = false;
    await sync(env, { type: 'releases', repo });
    assert.equal((await passagesFor(env, ids, 10))[0]?.metadata.release_status, 'unknown');
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM github_release_commits').get()?.n, 0);
  } finally { restore(); sqlite.close(); }
});

test('docs snapshots remove deleted files and reject obsolete snapshot writes', async () => {
  const { env, sqlite, jobs } = fixture();
  sqlite.exec("INSERT INTO repositories(repo,description,default_branch) VALUES('TrainLCD/MobileApp','app','dev')");
  await saveSource(env, { id: 'TrainLCD/MobileApp:deleted.md', repo: 'TrainLCD/MobileApp', kind: 'doc', title: 'deleted.md', url: 'https://github.com/TrainLCD/MobileApp', body: 'obsolete', metadata: {}, updated_at: '2026-11-01' });
  const restore = mockFetch(url => {
    if (url.includes('/commits/')) return Response.json({ sha: 'commit-new', commit: { tree: { sha: 'tree-new' } } });
    if (url.includes('/git/trees/')) return Response.json({ truncated: false, tree: [{ path: 'README.md', type: 'blob', sha: 'blob-new', size: 20 }] });
    if (url.includes('/git/blobs/')) return Response.json({ encoding: 'base64', content: Buffer.from('新しい説明書').toString('base64') });
    throw new Error(url);
  });
  try {
    await sync(env, { type: 'docs', repo: 'TrainLCD/MobileApp' });
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM sources').get()?.n, 0);
    await sync(env, { type: 'doc', repo: 'TrainLCD/MobileApp', path: 'deleted.md', sha: 'old', commit: 'commit-old' });
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM sources').get()?.n, 0);
    await sync(env, jobs[0]!);
    const row = sqlite.prepare('SELECT * FROM sources').get();
    assert.equal(row?.body, '新しい説明書'); assert.match(String(row?.url), /blob\/commit-new\/README.md/);
  } finally { restore(); sqlite.close(); }
});

test('truncated trees fail without deleting existing documents', async () => {
  const { env, sqlite } = fixture();
  sqlite.exec("INSERT INTO repositories(repo,description,default_branch) VALUES('TrainLCD/MobileApp','app','dev')");
  const restore = mockFetch(url => Response.json(url.includes('/commits/')
    ? { sha: 'new', commit: { tree: { sha: 'tree' } } } : { truncated: true, tree: [] }));
  try { await assert.rejects(sync(env, { type: 'docs', repo: 'TrainLCD/MobileApp' }), /github_tree_truncated/); }
  finally { restore(); sqlite.close(); }
});

async function signedRequest(body: string, secret: string, event = 'issues') {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  const signature = 'sha256=' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return new Request('https://example.test/webhooks/github', { method: 'POST', body,
    headers: { 'x-hub-signature-256': signature, 'x-github-event': event } });
}
test('webhook verifies exact raw body and prevents cross-org ingestion', async () => {
  const { env, sqlite, jobs } = fixture();
  const body = JSON.stringify({ repository: { full_name: 'TrainLCD/Issues' }, issue: { number: 1 }, action: 'edited' });
  assert.equal(await verifySignature(env.WEBHOOK_SECRET, body, null), false);
  await assert.rejects(webhook(new Request('https://example.test/webhooks/github', { method: 'POST', body }), env), /invalid_webhook_signature/);
  assert.equal(jobs.length, 0);
  assert.equal((await webhook(await signedRequest(body, env.WEBHOOK_SECRET), env)).status, 202);
  assert.deepEqual(jobs, [{ type: 'issue', repo: 'TrainLCD/Issues', number: 1 }]);
  await assert.rejects(webhook(await signedRequest(body.replace('TrainLCD', 'OtherOrg'), env.WEBHOOK_SECRET), env), /repository_out_of_scope/);
  sqlite.close();
});

test('feedback and administrative APIs require a configured token', async () => {
  const { env, sqlite } = fixture();
  const context = {} as ExecutionContext;
  const fetch = worker.fetch!;
  const feedback = (path: string) => new Request<unknown, IncomingRequestCfProperties>(`https://example.test/${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '報告は？', include_feedback: true }) });
  assert.equal((await fetch(feedback('search'), env, context)).status, 401);
  assert.equal((await fetch(feedback('answer'), { ...env, API_TOKEN: '' }, context)).status, 503);
  assert.equal((await fetch(new Request('https://example.test/sync/status'), env, context)).status, 401);
  const valid = await fetch(new Request('https://example.test/search', { method: 'POST', headers: { Authorization: `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '報告は？' }) }), env, context);
  assert.equal(valid.status, 200); assert.equal((await valid.json() as { status: string }).status, 'empty');
  sqlite.close();
});



test('issue watermark waits for saving and retries resume the same page', async () => {
  const { env, sqlite } = fixture();
  const repo = 'TrainLCD/Issues';
  sqlite.prepare('INSERT INTO repositories(repo,default_branch,issues_dispatched_at) VALUES(?,?,?)').run(repo, 'main', '2026-01-01T00:00:00.000Z');
  let fail = true;
  const fetched: number[] = [];
  const restore = mockFetch(url => {
    if (url.includes('/issues?')) return Response.json([{ number: 1 }, { number: 2 }]);
    if (url.endsWith('/comments?per_page=100&page=1')) return Response.json([]);
    const n = Number(url.match(/\/issues\/(\d+)/)?.[1]);
    fetched.push(n);
    if (n === 2 && fail) return Response.json({}, { status: 500 });
    return Response.json({ ...issue, number: n });
  });
  let ack = 0, retry = 0;
  const body = { type: 'issues', repo, page: 1, started: '2026-11-12T00:00:00.000Z' };
  const messages = [{ id: 'resume-issues', body, attempts: 1, ack() { ack++; }, retry() { retry++; } }];
  try {
    await worker.queue!({ messages } as unknown as MessageBatch<any>, env, {} as ExecutionContext);
    assert.equal(retry, 1); assert.equal(ack, 0);
    assert.equal(sqlite.prepare('SELECT issues_dispatched_at AS t FROM repositories').get()?.t, '2026-01-01T00:00:00.000Z');
    assert.equal(JSON.parse(String(sqlite.prepare('SELECT job FROM sync_jobs').get()?.job)).offset, 1);
    fail = false;
    await worker.queue!({ messages } as unknown as MessageBatch<any>, env, {} as ExecutionContext);
    assert.equal(ack, 1);
    assert.equal(fetched.filter(n => n === 1).length, 1);
    assert.equal(sqlite.prepare('SELECT issues_dispatched_at AS t FROM repositories').get()?.t, body.started);
  } finally { restore(); sqlite.close(); }
});

test('an older docs fetch cannot reactivate a replaced snapshot', async () => {
  const { env, sqlite } = fixture();
  const repo = 'TrainLCD/MobileApp';
  sqlite.prepare('INSERT INTO repositories(repo,default_branch,docs_commit) VALUES(?,?,?)').run(repo, 'main', 'original');
  const restore = mockFetch(url => {
    if (url.includes('/commits/')) return Response.json({ sha: 'old', commit: { tree: { sha: 'old-tree' } } });
    sqlite.prepare('UPDATE repositories SET docs_commit=? WHERE repo=?').run('new', repo);
    return Response.json({ tree: [], truncated: false });
  });
  try {
    await assert.rejects(sync(env, { type: 'docs', repo }), /docs_snapshot_changed/);
    assert.equal(sqlite.prepare('SELECT docs_commit FROM repositories').get()?.docs_commit, 'new');
  } finally { restore(); sqlite.close(); }
});

test('resyncing an unchanged document preserves its complete searchable record', async () => {
  const { env, sqlite } = fixture();
  const repo = 'TrainLCD/MobileApp';
  sqlite.prepare('INSERT INTO repositories(repo,default_branch,docs_commit) VALUES(?,?,?)').run(repo, 'main', 'first');
  const restore = mockFetch(() => Response.json({ encoding: 'base64', content: Buffer.from('GPSの更新処理についての説明').toString('base64') }));
  try {
    const doc = { type: 'doc' as const, repo, path: 'README.md', sha: 'same-blob', commit: 'first' };
    await sync(env, doc);
    const before = sqlite.prepare('SELECT * FROM sources').get();
    sqlite.prepare('UPDATE repositories SET docs_commit=? WHERE repo=?').run('second', repo);
    await sync(env, { ...doc, commit: 'second' });
    assert.deepEqual(sqlite.prepare('SELECT * FROM sources').get(), before);
  } finally { restore(); sqlite.close(); }
});

test('release history retries resume from the last persisted cursor', async () => {
  const { env, sqlite } = fixture();
  const repo = 'TrainLCD/MobileApp', tip = 'a'.repeat(40), ancestor = 'b'.repeat(40);
  sqlite.prepare('INSERT INTO repositories(repo,default_branch) VALUES(?,?)').run(repo, 'main');
  let fail = true, firstPages = 0, ack = 0, retry = 0;
  const restore = mockFetch((_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes('latestRelease')) return Response.json({ data: { repository: { latestRelease: { tagName: 'v1', url: 'https://example.test/v1', publishedAt: '2026-11-01', isDraft: false, isPrerelease: false, tagCommit: { oid: tip } } } } });
    const first = variables.after === null;
    if (first) firstPages++;
    if (!first && fail) return Response.json({}, { status: 500 });
    return Response.json({ data: { repository: { object: { history: { totalCount: 2, nodes: [{ oid: first ? tip : ancestor }], pageInfo: { hasNextPage: first, endCursor: first ? 'next' : null } } } } } });
  });
  const messages = [{ id: 'release-resume', body: { type: 'releases', repo }, attempts: 1, ack() { ack++; }, retry() { retry++; } }];
  try {
    await worker.queue!({ messages } as unknown as MessageBatch<any>, env, {} as ExecutionContext);
    assert.equal(retry, 1);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM github_releases').get()?.n, 0);
    fail = false;
    await worker.queue!({ messages } as unknown as MessageBatch<any>, env, {} as ExecutionContext);
    assert.equal(firstPages, 1); assert.equal(ack, 1);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM github_release_commits').get()?.n, 2);
  } finally { restore(); sqlite.close(); }
});
