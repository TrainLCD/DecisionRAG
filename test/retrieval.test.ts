import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Jev, probability } from '../src/jev.js';
import { retrieve, d1Store, DEFAULT_BUDGETS, gate } from '../src/retrieval.js';
import { DOCUMENT_PAGE_SIZE, saveSource, splitPassages } from '../src/store.js';
import { answer } from '../src/answer.js';
import { fixture, mockFetch } from './helpers.js';

test('retrieves by shared-context hierarchy without lexical or vector filtering', async () => {
  const { env, sqlite } = fixture();
  sqlite.exec("INSERT INTO repositories(repo,description,default_branch) VALUES('TrainLCD/MobileApp','Mobile navigation','dev')");
  await saveSource(env, { id: 'TrainLCD/MobileApp#1', repo: 'TrainLCD/MobileApp', kind: 'pr', title: 'Restore continuous heartbeat',
    url: 'https://github.com/TrainLCD/MobileApp/pull/1', body: '地下では新しい測位が来ない間、ハートビートで補助する。',
    metadata: { base_branch: 'dev', merged_at: '2026-11-05', release_status: 'unknown' }, updated_at: '2026-11-05' });
  await saveSource(env, { id: 'TrainLCD/MobileApp#2', repo: 'TrainLCD/MobileApp', kind: 'pr', title: '地下鉄の駅名を修正',
    url: 'https://github.com/TrainLCD/MobileApp/pull/2', body: '駅名の翻訳を更新。', metadata: {}, updated_at: '2026-11-06' });
  const states: { candidates?: Record<string, string> }[] = [];
  const restore = mockFetch((url, init) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    const req = JSON.parse(String(init?.body));
    states.push(req.state);
    const answers = Object.fromEntries(Object.entries(req.questions).map(([key, value]) => {
      if ((value as { type: string }).type === 'choice') return [key, { type: 'choice', choice: 'c0', probabilities: { c0: 0.99, c1: 0.01 }, confidence: 0.99 }];
      const text = req.state.candidates[key] as string;
      return [key, { type: 'noul', noul: /heartbeat|ハートビート|implementation/.test(text) ? 0.95 : 0.1 }];
    }));
    return Response.json({ model: 'jev-test', answers, usage: { input_tokens: 100, output_tokens: 1 } });
  });
  try {
    const judge = new Jev(env);
    const evidence = await retrieve('地下鉄で位置が止まる問題への対応は？', d1Store(env), judge);
    assert.equal(evidence[0]?.source_id, 'TrainLCD/MobileApp#1');
    assert.ok(states.some(s => Object.values(s.candidates || {}).some(t => t.includes('Restore continuous heartbeat')) &&
      Object.values(s.candidates || {}).some(t => t.includes('地下鉄の駅名を修正'))));
    assert.deepEqual(judge.trace.map(t => t.stage), ['branch_screening', 'document_screening', 'passage_ranking']);
    assert.equal(evidence[0]?.metadata.release_status, 'unknown');
  } finally { restore(); sqlite.close(); }
});

test('screening budget never returns silently incomplete evidence', async () => {
  const { env, sqlite } = fixture();
  const judge = new Jev(env);
  const restore = mockFetch((_url, init) => {
    const req = JSON.parse(String(init?.body));
    return Response.json({ model: 'test', answers: Object.fromEntries(Object.keys(req.questions).map(k => [k, { type: 'noul', noul: 0.9 }])), usage: { input_tokens: 1, output_tokens: 1 } });
  });
  try {
    await assert.rejects(retrieve('query', {
      branches: async () => [{ id: 'b', repo: 'TrainLCD/MobileApp', kind: 'pr', description: 'branch' }],
      documentPages: async () => [[{ id: 'd1', description: 'one' }, { id: 'd2', description: 'two' }]],
      passages: async () => { throw new Error('Must not expand partial corpus'); },
    }, judge, { ...DEFAULT_BUDGETS, maxDocuments: 1 }), /document_screening_budget_exceeded/);
  } finally { restore(); sqlite.close(); }
});

test('batched document pages retain branch order and screen the tail of a full page', async () => {
  const { env, sqlite } = fixture();
  sqlite.exec(`INSERT INTO repositories(repo,description,default_branch) VALUES('TrainLCD/App','App','main');
    WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<${DOCUMENT_PAGE_SIZE})
    INSERT INTO sources(id,repo,kind,title,url,body,metadata,updated_at)
    SELECT printf('issue%04d',i),'TrainLCD/App','issue',printf('issue%04d',i),'url','','{}','today' FROM n
    UNION ALL SELECT 'pr','TrainLCD/App','pr','pr','url','','{}','today'`);
  const store = d1Store(env);
  const cursorBatches: string[][] = [];
  const documentIds: string[] = [];
  const judge = new Jev(env);
  judge.score = async (_query, items, stage) => {
    if (stage === 'document_screening') documentIds.push(...items.map(item => item.id));
    return items.map(item => ({ item, probability: 1 }));
  };
  try {
    await retrieve('query', { ...store, documentPages: cursors => {
      cursorBatches.push(cursors.map(({ branch }) => branch.kind));
      return store.documentPages(cursors);
    } }, judge);
    assert.deepEqual(cursorBatches, [['issue', 'pr'], ['issue']]);
    assert.equal(documentIds.length, DOCUMENT_PAGE_SIZE + 2);
    assert.deepEqual(documentIds.slice(-2), [`issue${String(DOCUMENT_PAGE_SIZE).padStart(4, '0')}`, 'pr']);
  } finally { sqlite.close(); }
});

test('passage ranking still screens before Choice when the shortlist would prune candidates', async () => {
  const { env, sqlite } = fixture();
  const calls: string[][] = [];
  const restore = mockFetch((_url, init) => {
    const { state } = JSON.parse(String(init?.body));
    const options = Object.values<string>(state.candidates ?? state.passages);
    calls.push(options);
    const answers = state.candidates
      ? Object.fromEntries(Object.keys(state.candidates).map((id, i) => [id, { type: 'noul', noul: i / 10 }]))
      : { best: { type: 'choice', choice: 'p1', probabilities: { p0: 0.1, p1: 0.9 } } };
    return Response.json({ model: 'test', answers, usage: { input_tokens: 1, output_tokens: 1 } });
  });
  try {
    const judge = new Jev(env);
    const ranked = await judge.rankPassages('query', ['one', 'two', 'three'].map(id => ({ id, description: id })), 2);
    assert.deepEqual(calls, [['one', 'two', 'three'], ['three', 'two']]);
    assert.deepEqual(ranked.map(({ item, probability }) => [item.id, probability]), [['two', 0.1], ['three', 0.2]]);
  } finally { restore(); sqlite.close(); }
});

test('support and conflict gates fail closed and validate thresholds', () => {
  const { env, sqlite } = fixture();
  assert.equal(gate(env, { supported: 0.2, conflict: 0.1 }), 'insufficient_evidence');
  assert.equal(gate(env, { supported: 0.99, conflict: 0.9 }), 'conflicting_evidence');
  assert.throws(() => gate({ ...env, SUPPORT_THRESHOLD: 'NaN' }, { supported: 1, conflict: 0 }), /invalid_configuration/);
  for (const value of [NaN, Infinity, -1, 2, '0.8', undefined]) assert.throws(() => probability(value), /invalid_jev_probability/);
  sqlite.close();
});

test('verified partial summaries are returned, but unsupported claims and unknown citations are withheld', async () => {
  const { env, sqlite } = fixture();
  const evidence = [{ id: 'p', source_id: 's', ordinal: 0, text: 'proposed change', title: 'Proposal', repo: 'TrainLCD/MobileApp',
    kind: 'pr' as const, metadata: { merged_at: null }, updated_at: '2026-11-06', url: 'https://github.com/TrainLCD/MobileApp/pull/1', citation: 'p1', relevance: 0.9 }];
  let calls = 0;
  let support = 0.99;
  let citations = ['p1'];
  let claimText = 'A change was proposed.';
  const restore = mockFetch((url, init) => {
    if (url.includes('typesafe')) {
      const { questions, state } = JSON.parse(String(init?.body));
      const answers = Object.fromEntries(Object.keys(questions).map(key => [key, { type: 'noul',
        noul: key === 'supported' || state.draft?.[key]?.text === 'A change was proposed.' ? support : 0.1 }]));
      return Response.json({ model: 'test', answers, usage: { input_tokens: 1, output_tokens: 1 } });
    }
    calls++;
    return Response.json({ model: 'test-generator', usage: { prompt_tokens: 100, completion_tokens: 20 }, choices: [{ message: { content: JSON.stringify({
      claims: [{ text: claimText, citations }, { text: 'The change was released.', citations: ['p1'] }],
    }) } }] });
  });
  try {
    const configured = { ...env, ANSWER_API_KEY: 'test', ANSWER_MODEL: 'test' };
    assert.equal((await answer('Released?', evidence, env, new Jev(env))).status, 'evidence_ready');
    assert.equal(calls, 0);
    const judge = new Jev(env);
    const summary = await answer('Released?', evidence, configured, judge);
    assert.equal(summary.status, 'summarized');
    assert.deepEqual(summary.citations, ['p1']);
    assert.equal(summary.answer, 'A change was proposed. [p1]');
    assert.equal(calls, 1);
    assert.deepEqual(judge.trace.map(step => step.stage), ['generate_answer', 'verify_answer']);
    assert.equal(judge.trace[0]?.output_tokens, 20);
    support = 0.2;
    const rejected = await answer('Released?', evidence, configured, new Jev(env));
    assert.equal(rejected.status, 'verification_failed');
    assert.equal(rejected.answer, null);
    citations = ['p999'];
    support = 0.99;
    assert.equal((await answer('Released?', evidence, configured, new Jev(env))).answer, null);
    const withSecondSource = [...evidence, { ...evidence[0]!, citation: 'p2' }];
    citations = ['p1', 'p2'];
    claimText = 'A change was proposed [p1, p2].';
    const normalized = await answer('Released?', withSecondSource, configured, new Jev(env));
    assert.equal(normalized.answer, 'A change was proposed. [p1] [p2]');
    citations = ['p1'];
    assert.equal((await answer('Released?', withSecondSource, configured, new Jev(env))).answer, null);
  } finally { restore(); sqlite.close(); }
});

test('passage replacement removes stale text and preserves tail and Unicode', async () => {
  const { env, sqlite } = fixture();
  const body = '冒頭\n\n' + 'あ'.repeat(8000) + '\n\n末尾';
  assert.ok(splitPassages(body).at(-1)?.includes('末尾'));
  assert.equal(splitPassages('x'.repeat(7300)).join(''), 'x'.repeat(7300));
  const source = { id: 'TrainLCD/Issues#1', repo: 'TrainLCD/Issues', kind: 'feedback' as const, title: '報告', url: 'https://github.com/TrainLCD/Issues/issues/1', body, metadata: {}, updated_at: '2026-11-06' };
  await saveSource(env, source);
  await saveSource(env, { ...source, body: '修正後' });
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM sources').get()?.n, 1);
  assert.equal(sqlite.prepare('SELECT text FROM passages').get()?.text, '修正後');
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM passages').get()?.n, 1);
  sqlite.close();
});
