import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCursor, decodeCursor } from '../src/search-cursor.js';
import { fixture, mockFetch } from './helpers.js';
import { saveSource, documentsFor } from '../src/store.js';
import worker from '../src/index.js';
import { planRetrieval } from '../src/retrieval.js';
import { Jev } from '../src/jev.js';

test('continuations are encrypted, scoped, authenticated and expire', async () => {
  const value = { query: '地下鉄', scope: '[true,true]', ids: ['private#42'], offset: 20, revision: 'abc', expires: Date.now() + 10000 };
  const token = await encodeCursor(value, 'secret');
  assert.ok(!token.includes('private'));
  assert.deepEqual(await decodeCursor(token, 'secret', value.query, value.scope), value);
  for (const [candidate, secret, query, scope] of [[token, 'wrong', value.query, value.scope],
    [token, 'secret', 'different', value.scope], [token, 'secret', value.query, '[false,false]'],
    ['A' + token.slice(1), 'secret', value.query, value.scope]])
    await assert.rejects(decodeCursor(candidate!, secret!, query!, scope!), /invalid_search_cursor/);
  const expired = await encodeCursor({ ...value, expires: 0 }, 'secret');
  await assert.rejects(decodeCursor(expired, 'secret', value.query, value.scope), /invalid_search_cursor/);
});

test('pagination evaluates only its passages, reuses planning, and rejects changes before model calls', async () => {
  const { env, sqlite } = fixture();
  sqlite.exec("INSERT INTO repositories(repo,description,default_branch) VALUES('TrainLCD/App','App','main')");
  for (let i = 0; i < 45; i++) await saveSource(env, { id: `doc${String(i).padStart(2, '0')}`, repo: 'TrainLCD/App', kind: 'issue',
    title: `Report ${i}`, body: `地下鉄で位置が止まる ${i}`, url: 'https://example.test', metadata: {}, updated_at: '2026-11-11' });
  let calls = 0;
  const restore = mockFetch((_url, init) => {
    calls++;
    const { state, questions } = JSON.parse(String(init?.body));
    const ids = Object.keys(state.candidates ?? state.passages);
    return Response.json({ model: 'test', usage: { input_tokens: 1, output_tokens: 1 }, answers: Object.fromEntries(
      Object.entries(questions).map(([id, q]) => [id, (q as { type: string }).type === 'choice'
        ? { type: 'choice', choice: ids[0], probabilities: Object.fromEntries(ids.map(key => [key, 1 / ids.length])) }
        : { type: 'noul', noul: 0.9 }])) });
  });
  const request = (body: object, authorization = `Bearer ${env.API_TOKEN}`) => worker.fetch!(new Request('https://example.test/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify({ query: '地下鉄', paginated: true, ...body }),
  }), env, {} as ExecutionContext);
  try {
    const docs = await documentsFor(env, 100);
    assert.ok(docs[0]?.overview?.includes('地下鉄で位置が止まる'));
    const first = await (await request({})).json() as any;
    assert.equal(first.evidence.length, 20);
    assert.equal(first.pagination.total_pages, 3);
    const next = await (await request({ cursor: first.pagination.next_cursor })).json() as any;
    assert.equal(next.evidence.length, 20);
    assert.equal(next.pagination.page, 2);
    assert.deepEqual(next.trace.map((x: any) => x.stage), ['passage_ranking']);
    assert.equal(new Set([...first.evidence, ...next.evidence].map((x: any) => x.id)).size, 40);
    const last = await (await request({ cursor: next.pagination.next_cursor })).json() as any;
    assert.equal(last.evidence.length, 5);
    assert.equal(last.pagination.next_cursor, null);
    const before = calls;
    sqlite.exec("UPDATE passages SET text='changed' WHERE source_id='doc00'");
    assert.equal((await request({ cursor: first.pagination.next_cursor })).status, 409);
    assert.equal(calls, before);
    assert.equal((await request({ cursor: first.pagination.next_cursor }, 'Bearer invalid')).status, 401);
  } finally { restore(); sqlite.close(); }
});

test('coarse routing considers body-only evidence and retains uncertain groups', async () => {
  const { env, sqlite } = fixture();
  const docs = Array.from({ length: 240 }, (_, i) => ({ id: `d${i}`, description: `generic title ${i}`,
    overview: i === 239 ? 'generic title: underground heartbeat fix' : `generic ${i}` }));
  const judge = new Jev(env);
  judge.score = async (_query, candidates, stage) => {
    if (stage === 'page_screening') {
      assert.ok(candidates.some(c => c.description.includes('underground heartbeat fix')));
      return candidates.map((item, i) => ({ item, probability: item.description.includes('heartbeat') ? 0.3 : i < 4 ? 0.8 : 0.01 }))
        .sort((a, b) => b.probability - a.probability);
    }
    assert.ok(candidates.some(c => c.id === 'd239'));
    assert.equal(candidates.length, 120);
    return candidates.map(item => ({ item, probability: 0.9 }));
  };
  try {
    const plan = await planRetrieval('underground', { documents: async () => docs, branches: async () => [], documentPages: async () => [], passages: async () => [] }, judge);
    assert.ok(plan.ids.includes('d239'));
  } finally { sqlite.close(); }
});
