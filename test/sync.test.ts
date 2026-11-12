import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sync } from './reference/sync.js';
import { passagesFor, saveSource } from './reference/store.js';
import { verifySignature, webhook } from './reference/webhook.js';
import { contractWorker as worker } from './helpers.js';
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
  const markdown = '## Public passage\n\n- **Detail**\n- [x] Verified\n\n<script>alert(1)</script>';
  const sources = [
    { repo: 'TrainLCD/MobileApp', kind: 'issue', title: 'Public issue', body: markdown },
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
      const payload = await response.json() as { hit_count: number; evidence: { title: string; text: string; text_html: string }[] };
      assert.equal(payload.hit_count, 1);
      assert.deepEqual(payload.evidence.map(item => item.title), ['Public issue']);
      assert.equal(payload.evidence[0]?.text, markdown);
      assert.match(payload.evidence[0]!.text_html, /<h2>Public passage<\/h2>[\s\S]*<strong>Detail<\/strong>/);
      assert.match(payload.evidence[0]!.text_html, /<input checked="" disabled="" type="checkbox">/);
      assert.doesNotMatch(payload.evidence[0]!.text_html, /<script/);
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

test('search and answer return all 31 matches while summarizing the top 20', async () => {
  const { env, sqlite } = fixture();
  const repo = 'TrainLCD/MobileApp';
  sqlite.prepare('INSERT INTO repositories(repo,description,default_branch) VALUES(?,?,?)').run(repo, '', 'main');
  for (let i = 1; i <= 32; i++) {
    await saveSource(env, { id: `${repo}#${String(i).padStart(2, '0')}`, repo, kind: 'issue', title: `Issue ${i}`,
      url: `https://github.com/${repo}/issues/${i}`, body: `## Passage ${i}`, metadata: {}, updated_at: '2026-11-10' });
  }
  const restore = mockFetch((url, init) => {
    if (url.endsWith('/chat/completions')) {
      const { messages } = JSON.parse(String(init?.body));
      const context = JSON.parse(messages[1].content.split('\n\n')[0]);
      assert.equal(context.evidence.length, 20);
      assert.equal(context.evidence[19].citation, 'p20');
      return Response.json({ choices: [{ message: { content: '{"claims":[{"text":"Relevant evidence.","citations":["p1"]}]}' } }] });
    }
    const { state, questions } = JSON.parse(String(init?.body));
    if (state.draft) assert.equal(state.evidence.length, 20);
    if (state.passages) assert.equal(Object.keys(state.passages).length, 20);
    const answers = Object.fromEntries(Object.entries(questions).map(([key, value]) => {
      if ((value as { type: string }).type === 'choice')
        return [key, { type: 'choice', choice: 'p0', probabilities: Object.fromEntries(Object.keys(state.passages).map(id => [id, id === 'p0' ? 1 : 0])) }];
      const irrelevant = state.candidates?.[key]?.includes('## Passage 32');
      return [key, { type: 'noul', noul: key === 'conflict' || irrelevant ? 0.1 : 0.9 }];
    }));
    return Response.json({ model: 'test', answers, usage: { input_tokens: 1, output_tokens: 1 } });
  });
  try {
    for (const path of ['search', 'answer']) {
      const response = await worker.fetch!(new Request(`https://example.test/${path}`, {
        method: 'POST', body: JSON.stringify({ query: 'Relevant evidence' }),
        headers: { Authorization: `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' },
      }), { ...env, ANSWER_API_KEY: 'test', ANSWER_MODEL: 'test' }, {} as ExecutionContext);
      assert.equal(response.status, 200);
      const data = await response.json() as { status: string; hit_count: number; evidence: { citation: string; text: string; text_html: string }[] };
      assert.equal(data.status, path === 'search' ? 'retrieved' : 'answered');
      assert.equal(data.hit_count, 31);
      assert.deepEqual(data.evidence.map(item => item.text), Array.from({ length: 31 }, (_, i) => `## Passage ${i + 1}`));
      assert.equal(data.evidence[30]?.citation, 'p31');
      assert.equal(data.evidence[30]?.text_html, '<h2>Passage 31</h2>');
    }
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


test('answer SSE preserves authentication and emits sources, drafts, then the verified result', async () => {
  const { env, sqlite } = fixture();
  const repo = 'TrainLCD/MobileApp';
  sqlite.prepare('INSERT INTO repositories(repo,description,default_branch) VALUES(?,?,?)').run(repo, '', 'main');
  await saveSource(env, { id: repo + '#1', repo, kind: 'issue', title: 'Report', url: 'https://github.com/' + repo + '/issues/1',
    body: 'A report exists.', metadata: {}, updated_at: '2026-11-11' });
  const restore = mockFetch((url, init) => {
    const input = JSON.parse(String(init?.body));
    if (url.endsWith('/chat/completions')) {
      assert.equal(input.stream, true);
      assert.equal(init?.redirect, 'manual');
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content:
        '{"claims":[{"text":"A report exists.","citations":["p1"]}],"summaries":[]}' } }] }) + '\n\ndata: [DONE]\n\n');
    }
    const answers = Object.fromEntries(Object.entries(input.questions).map(([key, value]) => {
      if ((value as { type: string }).type === 'choice') {
        const ids = Object.keys(input.state.candidates ?? input.state.passages);
        return [key, { type: 'choice', choice: ids[0], probabilities: Object.fromEntries(ids.map(id => [id, 1])) }];
      }
      return [key, { type: 'noul', noul: key === 'conflict' ? 0 : 1 }];
    }));
    return Response.json({ model: 'test', answers, usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const request = (token: string) => new Request<unknown, IncomingRequestCfProperties>('https://example.test/answer', { method: 'POST',
    headers: { Accept: 'text/event-stream', Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'Reports?' }) });
  try {
    const app = { ...env, ANSWER_MODEL: 'test', ANSWER_API_KEY: 'test' };
    const rejected = await worker.fetch!(request('invalid'), app, {} as ExecutionContext);
    assert.equal(rejected.status, 401);
    assert.match(rejected.headers.get('Content-Type')!, /application\/json/);
    const response = await worker.fetch!(request(env.API_TOKEN), app, {} as ExecutionContext);
    assert.match(response.headers.get('Content-Type')!, /text\/event-stream/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const body = await response.text();
    assert.ok(body.indexOf('event: sources') < body.indexOf('event: draft'));
    assert.ok(body.indexOf('event: draft') < body.indexOf('event: result'));
    const final = JSON.parse(body.split('event: result\ndata: ')[1]!.trim());
    assert.equal(final.status, 'answered');
    assert.equal(final.answer, 'A report exists. [p1]');
  } finally { restore(); sqlite.close(); }
});
