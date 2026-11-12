import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCursor, decodeCursor } from '../src/search-cursor.js';
import { fixture, mockFetch } from './helpers.js';
import { saveSource, documentsFor, documentPages, localReferences } from '../src/store.js';
import { contractWorker as worker } from './helpers.js';
import { planRetrieval, retrievePlannedPage } from '../src/retrieval.js';
import { Jev } from './legacy-judge.js';

test('full-result API counts relevant passages, retains tail matches and agrees across JSON and SSE', async () => {
  const { env, sqlite } = fixture();
  sqlite.exec("INSERT INTO repositories(repo,description,default_branch) VALUES('TrainLCD/App','App','main')");
  for (let i = 0; i < 160; i++) await saveSource(env, {
    id: `doc${String(i).padStart(3, '0')}`, repo: 'TrainLCD/App', kind: 'issue', title: `Record ${i}`,
    body: `MARKER_${i}`, url: 'https://example.test', metadata: {}, updated_at: '2026-11-11',
  });
  let hits = 0;
  const restore = mockFetch((_url, init) => {
    const { state, questions } = JSON.parse(String(init?.body));
    const answers = Object.fromEntries(Object.entries(questions).map(([id, q]) => {
      if ((q as { type: string }).type === 'choice') {
        const ids = Object.keys(state.passages);
        return [id, { type: 'choice', choice: ids[0], probabilities: Object.fromEntries(ids.map(key => [key, 1 / ids.length])) }];
      }
      const text: string = state.candidates?.[id] ?? '';
      const passage = text.includes('Repository:');
      const index = Number(text.match(/MARKER_(\d+)/)?.[1]);
      return [id, { type: 'noul', noul: passage && index < 160 - hits ? 0.1 : 0.9 }];
    }));
    return Response.json({ model: 'test', answers, usage: { input_tokens: 1, output_tokens: 1 } });
  });
  try {
    for (hits of [0, 11, 20, 21, 151]) {
      const expected = Array.from({ length: hits }, (_, i) => `doc${String(160 - hits + i).padStart(3, '0')}`);
      for (const mode of ['search', 'answer', 'stream']) {
        const response = await worker.fetch!(new Request(`https://example.test/${mode === 'search' ? 'search' : 'answer'}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.API_TOKEN}`,
            ...(mode === 'stream' ? { Accept: 'text/event-stream' } : {}) },
          body: JSON.stringify({ query: 'records' }),
        }), { ...env, AI: env.AI }, {} as ExecutionContext);
        assert.equal(response.status, 200);
        const payloads = mode === 'stream'
          ? (await response.text()).split('\n\n').filter(block => /^event: (sources|result)\n/.test(block))
            .map(block => JSON.parse(block.slice(block.indexOf('data: ') + 6)))
          : [await response.json()];
        assert.equal(payloads.length, mode === 'stream' ? 2 : 1);
        for (const data of payloads as any[]) {
          assert.equal(data.hit_count, hits);
          assert.equal(data.evidence.length, hits);
          assert.equal(data.pagination, undefined, 'full results must never carry candidate-page totals');
          assert.deepEqual(data.evidence.map((p: any) => p.source_id).sort(), expected);
          assert.equal(new Set(data.evidence.map((p: any) => p.id)).size, hits);
          assert.equal(new Set(data.evidence.map((p: any) => p.citation)).size, hits);
        }
      }
    }
  } finally { restore(); sqlite.close(); }
});

test('continuations are encrypted, scoped, authenticated and expire', async () => {
  const value = { query: '地下鉄', scope: '[true,true]', ids: ['private#42'], offset: 20, revision: 'abc', expires: Date.now() + 10000 };
  const token = await encodeCursor(value, 'secret');
  assert.ok(!token.includes('private'));
  assert.deepEqual(await decodeCursor(token, 'secret', value.query, value.scope), value);
  for (const [candidate, secret, query, scope] of [[token, 'wrong', value.query, value.scope],
    [token, 'secret', 'different', value.scope], [token, 'secret', value.query, '[false,false]'],
    [(token[0] === 'A' ? 'B' : 'A') + token.slice(1), 'secret', value.query, value.scope]])
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
    assert.deepEqual(next.trace.map((x: any) => x.stage), ['passage_scoring', 'choice_rerank']);
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

test('explicit references retain terse fixes without crossing the loaded search scope', async () => {
  const { env, sqlite } = fixture();
  const judge = new Jev(env);
  const docs = [{ id: 'TrainLCD/App#1', description: 'underground failure', references: [] },
    { id: 'TrainLCD/App#2', description: 'fix', references: ['TrainLCD/App#1', 'TrainLCD/Private#3'] },
    { id: 'TrainLCD/App#4', description: 'unrelated', references: [] }];
  judge.score = async (_query, items) => items.map(item => ({ item, probability: item.id.endsWith('#1') ? 0.9 : 0.01 }));
  try {
    const plan = await planRetrieval('underground', { documents: async () => docs, branches: async () => [], documentPages: async () => [], passages: async () => [] }, judge,
      { branches: 6, documents: 1, maxDocuments: 100, maxPassages: 4000 });
    assert.deepEqual(plan.ids, ['TrainLCD/App#1', 'TrainLCD/App#2']);
  } finally { sqlite.close(); }
});


test('local references never reinterpret cross-repository links as local issues', () => {
  assert.deepEqual(localReferences('TrainLCD/App#2', 'closes #1 related: #3 #1 Other/Repo#4 https://example.test/#5'),
    ['TrainLCD/App#1', 'TrainLCD/App#3']);
});

test('long sources do not crowd short relevant sources out of the first page', async () => {
  const { env, sqlite } = fixture();
  const judge = new Jev(env);
  judge.rankPassages = async (_query, items) => items.map(item => ({ item, probability: 0.9 }));
  const passages = Array.from({ length: 21 }, (_, i) => ({ id: `long:${i}`, source_id: 'long', ordinal: i,
    title: 'Long document', text: `section ${i}`, url: 'https://example.test/long', repo: 'TrainLCD/App', kind: 'doc' as const, metadata: {}, updated_at: 'now' }));
  passages.push({ ...passages[0]!, id: 'short:0', source_id: 'short', title: 'Short issue' });
  const store = { documents: async () => [], branches: async () => [], documentPages: async () => [], passages: async () => passages.map(p => ({ ...p })) };
  try {
    const first = await retrievePlannedPage('query', store, judge, { ids: ['long', 'short'] });
    assert.deepEqual(first.evidence.slice(0, 3).map(p => p.id), ['long:0', 'short:0', 'long:1']);
    const next = await retrievePlannedPage('query', store, judge, { ids: ['long', 'short'] }, 20, 20, undefined, first.revision);
    assert.equal(new Set([...first.evidence, ...next.evidence].map(p => p.id)).size, 22);
  } finally { sqlite.close(); }
});

test('linked passage context contains scoped body evidence and does not alter returned source text', async () => {
  const { env, sqlite } = fixture();
  const judge = new Jev(env);
  const base = { ordinal: 0, url: 'https://example.test', repo: 'TrainLCD/App', kind: 'issue' as const, metadata: {}, updated_at: 'now' };
  const passages = [{ ...base, id: 'fix:0', source_id: 'TrainLCD/App#2', title: 'Fix', text: 'related: #1 and #3' },
    { ...base, id: 'issue:0', source_id: 'TrainLCD/App#1', title: 'Report', text: 'Body-only evidence about underground accuracy' }];
  judge.rankPassages = async (_query, items) => {
    assert.ok(items[0]!.description.includes('Body-only evidence about underground accuracy'));
    assert.ok(!items[0]!.description.includes('TrainLCD/App#3:'));
    assert.ok(items[1]!.description.includes('TrainLCD/App#2: Fix'));
    assert.ok(!items[1]!.description.includes('TrainLCD/App#3:'));
    return items.map(item => ({ item, probability: 0.9 }));
  };
  try {
    const page = await retrievePlannedPage('query', { documents: async () => [], branches: async () => [], documentPages: async () => [], passages: async () => passages }, judge,
      { ids: ['TrainLCD/App#2', 'TrainLCD/App#1'] });
    assert.equal(page.evidence[0]!.text, 'related: #1 and #3');
    assert.ok(!('description' in page.evidence[0]!));
  } finally { sqlite.close(); }
});

test('references inside the loaded introduction survive both document loading paths', async () => {
  const { env, sqlite } = fixture();
  sqlite.exec("INSERT INTO repositories(repo,description,default_branch) VALUES('TrainLCD/App','App','main')");
  try {
    await saveSource(env, { id: 'TrainLCD/App#2', repo: 'TrainLCD/App', kind: 'pr', title: 'Fix',
      body: 'x'.repeat(180) + '\nrelated: #123\n' + 'y'.repeat(600), url: 'https://example.test', metadata: {}, updated_at: 'now' });
    const direct = await documentsFor(env, 10);
    const [page] = await documentPages(env, [{ branch: { id: 'TrainLCD/App/pr', repo: 'TrainLCD/App', kind: 'pr', description: 'PRs' }, after: '' }]);
    assert.deepEqual(direct[0]!.references, ['TrainLCD/App#123']);
    assert.deepEqual(page![0]!.references, ['TrainLCD/App#123']);
  } finally { sqlite.close(); }
});


test('coarse routing splits long descriptions without losing candidates or exceeding the judge limit', async () => {
  const { env, sqlite } = fixture();
  const docs = Array.from({ length: 130 }, (_, i) => ({ id: `d${i}`, description: '本文'.repeat(i === 0 ? 12000 : 1000) }));
  const judge = new Jev(env);
  judge.score = async (_query, items) => {
    assert.ok(items.every(item => item.description.length <= 24000));
    return items.map(item => ({ item, probability: 0.9 }));
  };
  try {
    const plan = await planRetrieval('本文', { documents: async () => docs, branches: async () => [], documentPages: async () => [], passages: async () => [] }, judge);
    assert.deepEqual(new Set(plan.ids), new Set(docs.map(doc => doc.id)));
  } finally { sqlite.close(); }
});


test('coarse grouping respects the full Unicode request budget through the real judge', async () => {
  const { env, sqlite } = fixture();
  const docs = Array.from({ length: 130 }, (_, i) => ({ id: `d${i}`, description: `${i}:` + '地下'.repeat(1000) }));
  let calls = 0;
  env.AI = { async run(model: string, input: { state: unknown; questions: Record<string, unknown> }) {
    calls++;
    const bytes = new TextEncoder().encode(JSON.stringify({ state: input.state, questions: input.questions })).byteLength;
    assert.ok(bytes + 4096 <= (model.endsWith('clef-flash') ? 24576 : 65536));
    return { model, answers: Object.fromEntries(Object.keys(input.questions).map(id => [id, { type: 'noul', noul: 0.9 }])),
      usage: { input_tokens: 1, output_tokens: 0 } };
  } } as unknown as typeof env.AI;
  try {
    const plan = await planRetrieval('質問'.repeat(750), { documents: async () => docs, branches: async () => [], documentPages: async () => [], passages: async () => [] }, new Jev(env));
    assert.deepEqual(new Set(plan.ids), new Set(docs.map(doc => doc.id)));
    assert.ok(calls > 1);
  } finally { sqlite.close(); }
});

