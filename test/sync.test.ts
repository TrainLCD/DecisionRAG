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

test('public search and answers keep private and feedback sources out of model requests', async () => {
  const { env, sqlite } = fixture();
  const app = { ...env, PUBLIC_SEARCH_RATE_LIMIT: { limit: async () => ({ success: true }) } };
  const context = {} as ExecutionContext;
  const sources = [
    { repo: 'TrainLCD/MobileApp', kind: 'issue', title: 'Public issue', body: 'Public passage' },
    { repo: 'TrainLCD/MobileApp', kind: 'pr', title: 'Public PR', body: 'PR text\nPENDING\nUnpublished review' },
    { repo: 'TrainLCD/Issues', kind: 'feedback', title: 'Private feedback', body: 'Restricted feedback' },
    { repo: 'TrainLCD/Issues', kind: 'doc', title: 'Private feedback README', body: 'Restricted README' },
    { repo: 'TrainLCD/Private', kind: 'issue', title: 'Private issue', body: 'Restricted issue' },
  ] as const;
  const insertRepo = sqlite.prepare('INSERT OR IGNORE INTO repositories(repo,description,default_branch) VALUES(?,?,?)');
  for (const [i, source] of sources.entries()) {
    insertRepo.run(source.repo, source.repo, 'main');
    await saveSource(app, { ...source, id: `${source.repo}#${i}`, url: `https://github.com/${source.repo}`,
      metadata: {}, updated_at: '2026-11-10' });
  }
  const inputs: string[] = [];
  let githubAvailable = true;
  let githubCalls = 0;
  let mobileAppPublic = true;
  const restore = mockFetch((url, init) => {
    if (url.includes('api.github.com')) {
      githubCalls++;
      assert.equal(new URL(url).searchParams.get('type'), 'public');
      const previous = new Headers(init?.headers).get('If-None-Match');
      assert.equal(previous, githubCalls === 1 ? null : '"public-v1"');
      if (!githubAvailable) return Response.json({}, { status: 503 });
      if (previous && mobileAppPublic) return new Response(null, { status: 304 });
      return Response.json([
        { full_name: 'TrainLCD/MobileApp', private: !mobileAppPublic, visibility: mobileAppPublic ? 'public' : 'private' },
        { full_name: 'TrainLCD/Issues', private: false, visibility: 'public' },
        { full_name: 'TrainLCD/Private', private: true, visibility: 'private' },
      ], { headers: { ETag: mobileAppPublic ? '"public-v1"' : '"public-v2"' } });
    }
    const { state, questions } = JSON.parse(String(init?.body));
    inputs.push(JSON.stringify(state));
    return Response.json({ model: 'test', usage: { input_tokens: 1, output_tokens: 1 },
      answers: Object.fromEntries(Object.entries(questions).map(([id, item]) => {
        const question = item as { type: string; criteria?: Record<string, string> };
        const options = Object.keys(question.criteria || {});
        return [id, question.type === 'choice' ? { type: 'choice', choice: options[0],
          probabilities: Object.fromEntries(options.map(option => [option, 1 / options.length])) }
          : { type: 'noul', noul: id === 'conflict' ? 0.1 : 0.99 }];
      })) });
  });
  const request = (path: string, includeFeedback: boolean, token?: string) => new Request<unknown, IncomingRequestCfProperties>(`https://example.test/${path}`, {
    method: 'POST', body: JSON.stringify({ query: 'reported issues', include_feedback: includeFeedback }),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  try {
    for (const path of ['search', 'answer']) {
      const response = await worker.fetch!(request(path, false), { ...app, API_TOKEN: '' }, context);
      assert.equal(response.status, 200);
      const payload = await response.json() as { hit_count: number; evidence: { title: string }[] };
      assert.equal(payload.hit_count, 1);
      assert.deepEqual(payload.evidence.map(item => item.title), ['Public issue']);
      assert.doesNotMatch(JSON.stringify(payload), /TrainLCD\/(Issues|Private)|Unpublished review/);
    }
    assert.doesNotMatch(inputs.join('\n'), /TrainLCD\/(Issues|Private)|Restricted|Unpublished review/);
    const authenticated = await worker.fetch!(request('search', true, env.API_TOKEN), app, context);
    assert.equal(authenticated.status, 200);
    const payload = await authenticated.json() as { evidence: { title: string }[] };
    assert.deepEqual(payload.evidence.map(item => item.title).sort(), ['Private feedback', 'Public issue']);

    const callsBeforeFailure = inputs.length;
    const limited = await worker.fetch!(request('search', false), { ...app,
      PUBLIC_SEARCH_RATE_LIMIT: { limit: async () => ({ success: false }) } }, context);
    assert.equal(limited.status, 429);
    githubAvailable = false;
    assert.equal((await worker.fetch!(request('search', false), app, context)).status, 502);
    assert.equal(inputs.length, callsBeforeFailure);
    githubAvailable = true;
    mobileAppPublic = false;
    const nowPrivate = await worker.fetch!(request('search', false), app, context);
    const privatePayload = await nowPrivate.json() as { evidence: unknown[]; hit_count: number };
    assert.deepEqual(privatePayload.evidence, []);
    assert.equal(privatePayload.hit_count, 0);
    assert.equal(inputs.length, callsBeforeFailure);
  } finally { restore(); sqlite.close(); }
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
