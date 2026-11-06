import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sync } from '../src/sync.js';
import { saveSource } from '../src/store.js';
import { verifySignature, webhook } from '../src/webhook.js';
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
    if (url.includes('/reviews')) return Response.json([{ id: 2, body: 'Only for dev', state: 'APPROVED', user: { login: 'reviewer' }, html_url: 'https://github.com/TrainLCD/MobileApp/pull/1#pullrequestreview-2' }]);
    if (url.includes('/comments')) return Response.json([]);
    if (url.includes('/files')) return Response.json([{ filename: 'src/heartbeat.ts', status: 'modified' }]);
    return Response.json({ merged_at: '2026-11-06', merge_commit_sha: 'abc', draft: false, base: { ref: 'dev' }, head: { ref: 'fix' } });
  });
  try {
    await sync(env, { type: 'issue', repo: 'TrainLCD/MobileApp', number: 1 });
    const row = sqlite.prepare('SELECT * FROM sources').get();
    assert.equal(row?.kind, 'pr'); assert.match(String(row?.body), /Only for dev/); assert.match(String(row?.body), /heartbeat.ts/);
    const metadata = JSON.parse(String(row?.metadata));
    assert.equal(metadata.base_branch, 'dev'); assert.equal(metadata.release_status, 'unknown');
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
  await assert.rejects(webhook(new Request('https://example.test', { method: 'POST', body }), env), /invalid_webhook_signature/);
  assert.equal(jobs.length, 0);
  assert.equal((await webhook(await signedRequest(body, env.WEBHOOK_SECRET), env)).status, 202);
  assert.deepEqual(jobs, [{ type: 'issue', repo: 'TrainLCD/Issues', number: 1 }]);
  await assert.rejects(webhook(await signedRequest(body.replace('TrainLCD', 'OtherOrg'), env.WEBHOOK_SECRET), env), /repository_out_of_scope/);
  sqlite.close();
});

test('API denies unauthenticated queries and fails closed if token absent', async () => {
  const { env, sqlite } = fixture();
  const context = {} as ExecutionContext;
  const fetch = worker.fetch!;
  assert.equal((await fetch(new Request('https://example.test/search', { method: 'POST' }), env, context)).status, 401);
  assert.equal((await fetch(new Request('https://example.test/search', { method: 'POST' }), { ...env, API_TOKEN: '' }, context)).status, 503);
  const valid = await fetch(new Request('https://example.test/search', { method: 'POST', headers: { Authorization: `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '報告は？' }) }), env, context);
  assert.equal(valid.status, 200); assert.equal((await valid.json() as { status: string }).status, 'empty');
  sqlite.close();
});

test('atomic snapshot guard prevents stale jobs from erasing newer passages', async () => {
  const { env, sqlite } = fixture();
  sqlite.exec("INSERT INTO repositories(repo,description,default_branch,docs_commit) VALUES('TrainLCD/MobileApp','app','dev','new')");
  const source = { id: 'TrainLCD/MobileApp:README.md', repo: 'TrainLCD/MobileApp', kind: 'doc' as const,
    title: 'README.md', url: 'https://github.com/TrainLCD/MobileApp', body: 'new content', metadata: {}, updated_at: '2026-11-06' };
  await saveSource(env, source, { repo: source.repo, commit: 'new' });
  await saveSource(env, { ...source, body: 'stale content' }, { repo: source.repo, commit: 'old' });
  assert.equal(sqlite.prepare('SELECT body FROM sources').get()?.body, 'new content');
  assert.equal(sqlite.prepare('SELECT text FROM passages').get()?.text, 'new content');
  sqlite.close();
});
