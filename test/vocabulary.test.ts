import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { rustWorker } from '../src/worker.js';
import { fixture, mockFetch } from './helpers.js';
import { saveSource } from './reference/store.js';
import { sync } from './rust-services.js';

async function setup() {
  const f = fixture();
  f.sqlite.exec("INSERT INTO repositories(repo,description,default_branch) VALUES('TrainLCD/App','','main'),('TrainLCD/Secret','','main')");
  const save = (body: string, id = 'definition', repo = 'TrainLCD/App') => saveSource(f.env, {
    id, repo, kind: 'doc', title: id, body, url: 'https://example.test/' + id, metadata: {}, updated_at: '2026-11-12',
  });
  const generated = { choices: [{ message: { content: JSON.stringify({ candidates: [
    { term: 'Wayfinder', alias: 'WF', relation: 'abbreviation', quote: 'Wayfinder (WF)' },
    { term: 'Wayfinder', alias: 'navigation', relation: 'related', quote: 'Wayfinder (WF)' },
  ] }) } }] };
  f.env.AI = { run: async () => generated } as unknown as Ai;
  const extract = (id = 'definition', repo = 'TrainLCD/App') => sync(f.env, { type: 'vocabulary', repo, source_id: id } as any);
  const request = (body: any, path = '/search', auth = true, preview = false) => (preview ? rustWorker(true) : worker).fetch!(new Request('https://example.test' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + f.env.API_TOKEN } : {}) }, body: JSON.stringify(body),
  }), f.env, {} as ExecutionContext);
  return { ...f, save, extract, request, generated };
}

test('synchronized aliases affect search, can be inspected/blocked/restored, and do not resurrect on resync', async () => {
  const f = await setup();
  try {
    await f.save('Wayfinder (WF)');
    await f.save('Wayfinder', 'target');
    const hits = async () => (await (await f.request({ query: 'WF' })).json() as any).evidence.map((e: any) => e.source_id);
    assert.ok(!(await hits()).includes('target'));
    await f.extract();
    assert.ok((await hits()).includes('target'));
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM vocabulary_entries').get()?.n, 1);
    const listed: any = await (await f.request({}, '/admin/vocabulary/list')).json();
    assert.equal(listed.items[0].quote, 'Wayfinder (WF)');
    assert.equal(listed.items[0].url, 'https://example.test/definition');
    assert.equal((await f.request({ term: 'WF', alias: 'Wayfinder', blocked: true, reason: 'Wrong meaning' }, '/admin/vocabulary')).status, 200);
    assert.ok(!(await hits()).includes('target'));
    await f.extract();
    assert.ok(!(await hits()).includes('target'));
    assert.equal((await f.request({ term: 'Wayfinder', alias: 'WF', blocked: false, reason: 'Definition corrected' }, '/admin/vocabulary')).status, 200);
    assert.ok((await hits()).includes('target'));
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM vocabulary_audit').get()?.n, 2);
    assert.equal((await f.request({}, '/admin/vocabulary/list', false)).status, 401);
    assert.equal((await f.request({}, '/admin/vocabulary', true, true)).status, 403);
  } finally { f.sqlite.close(); }
});

test('private definitions do not influence explicitly public searches', async () => {
  const f = await setup();
  const restore = mockFetch(() => Response.json([{ full_name: 'TrainLCD/App', private: false, visibility: 'public' }]));
  try {
    await f.save('Wayfinder (WF)', 'private-definition', 'TrainLCD/Secret');
    await f.save('Wayfinder', 'target');
    await f.extract('private-definition', 'TrainLCD/Secret');
    const result: any = await (await f.request({ query: 'WF', include_feedback: false })).json();
    assert.equal(result.hit_count, 0);
    const privateResult: any = await (await f.request({ query: 'WF' })).json();
    assert.ok(privateResult.evidence.some((e: any) => e.source_id === 'target'));
  } finally { restore(); f.sqlite.close(); }
});

test('source changes/deletion invalidate aliases; an in-flight extraction cannot restore stale data', async () => {
  const f = await setup();
  try {
    await f.save('Wayfinder (WF)');
    await f.extract();
    await f.save('Unrelated content');
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM vocabulary_entries').get()?.n, 0);
    await f.save('Wayfinder (WF)');
    f.env.AI = { run: async () => { await f.save('Changed while extracting'); return f.generated; } } as unknown as Ai;
    await f.extract();
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM vocabulary_entries').get()?.n, 0);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM vocabulary_runs').get()?.n, 0);
    f.env.AI = { run: async () => f.generated } as unknown as Ai;
    await f.save('Wayfinder (WF)');
    await f.extract();
    f.sqlite.exec("DELETE FROM sources WHERE id='definition'");
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM vocabulary_entries').get()?.n, 0);
  } finally { f.sqlite.close(); }
});

test('generation failure is retriable and leaves document ingestion intact', async () => {
  const f = await setup();
  try {
    await f.save('Wayfinder (WF)');
    f.env.AI = { run: async () => { throw new Error('rate limit'); } } as unknown as Ai;
    await assert.rejects(f.extract());
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM sources').get()?.n, 1);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM vocabulary_entries').get()?.n, 0);
    f.env.AI = { run: async () => f.generated } as unknown as Ai;
    await f.extract();
    assert.equal(f.sqlite.prepare('SELECT status FROM vocabulary_runs').get()?.status, 'completed');
  } finally { f.sqlite.close(); }
});

test('dictionary changes invalidate continuation cursors instead of mixing scoring rules', async () => {
  const f = await setup();
  try {
    await f.save('Wayfinder (WF)');
    for (let i = 0; i < 21; i++) await f.save('Wayfinder', 'target-' + i);
    await f.extract();
    const first: any = await (await f.request({ query: 'WF', paginated: true })).json();
    assert.ok(first.pagination.next_cursor);
    await f.request({ term: 'WF', alias: 'Wayfinder', blocked: true, reason: 'Regression' }, '/admin/vocabulary');
    const next = await f.request({ query: 'WF', paginated: true, cursor: first.pagination.next_cursor });
    assert.equal(next.status, 409);
  } finally { f.sqlite.close(); }
});

test('a multi-span source activates only after completion and retries resume persisted progress', async () => {
  const f = await setup();
  try {
    await f.save('Wayfinder (WF)\n\n' + 'Other unrelated content. '.repeat(150));
    await f.save('Wayfinder', 'target');
    await f.extract();
    assert.equal(f.sqlite.prepare('SELECT status FROM vocabulary_runs').get()?.status, 'running');
    const initial: any = await (await f.request({ query: 'WF' })).json();
    assert.ok(!initial.evidence.some((e: any) => e.source_id === 'target'));
    for (let i = 0; i < 10 && f.sqlite.prepare('SELECT status FROM vocabulary_runs').get()?.status !== 'completed'; i++) await f.extract();
    assert.equal(f.sqlite.prepare('SELECT status FROM vocabulary_runs').get()?.status, 'completed');
    const final: any = await (await f.request({ query: 'WF' })).json();
    assert.ok(final.evidence.some((e: any) => e.source_id === 'target'));
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM vocabulary_entries').get()?.n, 1);
  } finally { f.sqlite.close(); }
});

test('polite negated definitions are never stored or used in search', async () => {
  const f = await setup();
  try {
    const quote = 'Wayfinder (WF) は正式な略称ではありません';
    await f.save(quote);
    await f.save('Wayfinder', 'target');
    f.generated.choices[0]!.message.content = JSON.stringify({ candidates: [{ term: 'Wayfinder', alias: 'WF', relation: 'abbreviation', quote }] });
    await f.extract();
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM vocabulary_entries').get()?.n, 0);
    const result: any = await (await f.request({ query: 'WF' })).json();
    assert.ok(!result.evidence.some((e: any) => e.source_id === 'target'));
  } finally { f.sqlite.close(); }
});

test('substring collisions do not exhaust the expansion budget for unknown identifiers', async () => {
  const f = await setup();
  try {
    await f.save('Wayfinder (WF)');
    await f.extract();
    for (let i = 0; i < 130; i++) f.sqlite.prepare("INSERT INTO vocabulary_entries SELECT source_id,revision,0,?, 'wayfinder','quote','synonym','now' FROM vocabulary_runs").run('alias' + i);
    await f.save('xWayfinder123', 'identifier');
    const response = await f.request({ query: 'xWayfinder123' });
    assert.equal(response.status, 200);
    const result: any = await response.json();
    assert.ok(result.evidence.some((e: any) => e.source_id === 'identifier'));
    assert.equal((await f.request({ query: 'Wayfinder' })).status, 422);
  } finally { f.sqlite.close(); }
});

test('document retry recovers a queue failure after saving the blob, without re-extracting completed sources', async () => {
  const f = await setup();
  const repo = 'TrainLCD/App';
  f.sqlite.prepare('UPDATE repositories SET docs_commit=? WHERE repo=?').run('commit', repo);
  const restore = mockFetch(() => Response.json({ encoding: 'base64', content: Buffer.from('Wayfinder (WF)').toString('base64') }));
  const send = f.env.SYNC_QUEUE.send.bind(f.env.SYNC_QUEUE);
  let fail = true;
  f.env.SYNC_QUEUE.send = async (...args: Parameters<typeof send>) => { if (fail) throw new Error('queue unavailable'); return send(...args); };
  const job = { type: 'doc' as const, repo, path: 'glossary.md', sha: 'blob', commit: 'commit' };
  try {
    await assert.rejects(sync(f.env, job));
    assert.equal(f.sqlite.prepare('SELECT body FROM sources').get()?.body, 'Wayfinder (WF)');
    fail = false;
    await sync(f.env, job);
    assert.equal(f.jobs.length, 1);
    await f.extract('TrainLCD/App:glossary.md');
    await sync(f.env, job);
    assert.equal(f.jobs.length, 1);
  } finally { restore(); f.sqlite.close(); }
});
