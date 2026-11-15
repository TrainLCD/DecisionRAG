import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { fixture, mockFetch } from './helpers.js';
import { saveSource } from './reference/store.js';

async function setup(n = 41) {
  const f = fixture();
  f.env.RETRIEVAL_ENGINE = 'jev';
  f.env.TYPESAFE_API_KEY = 'test-jev-secret';
  f.env.AI = undefined;
  f.sqlite.exec("INSERT INTO repositories(repo,description,default_branch) VALUES('TrainLCD/App','App','main')");
  for (let i = 0; i < n; i++) await saveSource(f.env, {
    id: `bus${i}`, repo: 'TrainLCD/App', kind: 'doc', title: `事業者 ${i}`,
    body: `バスの対応一覧。事業者ID=${i}。`, url: `https://example.test/${i}`, metadata: {}, updated_at: '2026-11-15',
  });
  await saveSource(f.env, { id: 'population', repo: 'TrainLCD/App', kind: 'doc', title: '母集団', body: '全国の交通事業者の一覧と対象年度。', url: 'https://example.test/population', metadata: {}, updated_at: '2026-11-15' });
  await saveSource(f.env, { id: 'noise', repo: 'TrainLCD/App', kind: 'doc', title: 'アイコン配色', body: '背景色を変更する。', url: 'https://example.test/noise', metadata: {}, updated_at: '2026-11-15' });
  const request = (body: Record<string, unknown>, path = '/search', stream = false) => worker.fetch!(new Request('https://example.test' + path, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${f.env.API_TOKEN}`, ...(stream ? { accept: 'text/event-stream' } : {}) }, body: JSON.stringify(body),
  }), f.env, {} as ExecutionContext);
  return { ...f, request };
}

function decisions(body: any) {
  return { model: 'jev-1.14.0', answers: Object.fromEntries(Object.entries<string>(body.state.candidates).map(([id, text]) => [id,
    { type: 'noul', noul: /事業者|母集団/.test(text) ? 0.93 : 0.01 },
  ])), usage: { input_tokens: 400, output_tokens: 10 } };
}

test('real WASM sends the original question and shared candidates to Jev; cursors reuse decisions', async () => {
  const f = await setup();
  const queries: string[] = [];
  let calls = 0;
  let largest = 0;
  const restore = mockFetch((url, init) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-jev-secret');
    const body = JSON.parse(String(init?.body));
    calls++;
    largest = Math.max(largest, Object.keys(body.state.candidates).length);
    queries.push(body.state.query);
    return Response.json(decisions(body));
  });
  try {
    const query = 'バス対応の網羅率はどれくらいですか？';
    const first = await f.request({ query, paginated: true });
    assert.equal(first.status, 200);
    const result: any = await first.json();
    assert.equal(result.hit_count, 42);
    assert.equal(result.evidence.length, 20);
    assert.equal(result.pagination.total_pages, 3);
    assert.equal(result.retrieval, 'jev-semantic-v1');
    assert.equal(result.retrieval_details.coverage, 'bounded');
    assert.ok(largest > 1, 'Candidates must share a state, not one request per passage');
    assert.ok(queries.every(q => q === query));
    const firstCalls = calls;
    const ids = new Set(result.evidence.map((p: any) => p.id));
    let cursor = result.pagination.next_cursor;
    while (cursor) {
      const response = await f.request({ query, paginated: true, cursor });
      assert.equal(response.status, 200);
      const page: any = await response.json();
      assert.equal(page.hit_count, 42);
      assert.equal(page.retrieval_details.cached, true);
      for (const p of page.evidence) { assert.ok(!ids.has(p.id)); ids.add(p.id); }
      cursor = page.pagination.next_cursor;
    }
    assert.equal(ids.size, 42);
    assert.equal(calls, firstCalls, 'Pagination must not call Jev again');
    assert.ok(!JSON.stringify(result).includes('test-jev-secret'));
    f.sqlite.exec("UPDATE passages SET text=text||'変更' WHERE source_id='population'");
    assert.equal((await f.request({ query, paginated: true, cursor: result.pagination.next_cursor })).status, 409);
    assert.equal(calls, firstCalls);
  } finally { restore(); f.sqlite.close(); }
});

test('missing Jev key and malformed decisions fail explicitly instead of returning zero or using rules', async () => {
  const f = await setup(1);
  try {
    f.env.TYPESAFE_API_KEY = '';
    const missing = await f.request({ query: 'バス' });
    assert.equal(missing.status, 503);
    assert.equal((await missing.json() as any).error, 'jev_not_configured');
    f.env.TYPESAFE_API_KEY = 'test';
    const duplicate = mockFetch(() => new Response('{"model":"jev-1.14.0","answers":{"c0":{"type":"noul","noul":0.1},"c0":{"type":"noul","noul":0.9}},"usage":{"input_tokens":1,"output_tokens":1}}'));
    try {
      const response = await f.request({ query: 'バス' });
      assert.equal(response.status, 502);
      assert.equal((await response.json() as any).error, 'invalid_jev_response');
    } finally { duplicate(); }
    for (const bad of [{}, { wrong: { type: 'noul', noul: 0.9 } }]) {
      const restore = mockFetch(() => Response.json({ model: 'jev-1.14.0', answers: bad, usage: { input_tokens: 1, output_tokens: 0 } }));
      try {
        const response = await f.request({ query: 'バス' });
        assert.equal(response.status, 502);
        assert.equal((await response.json() as any).error, 'invalid_jev_answers');
      } finally { restore(); }
    }
  } finally { f.sqlite.close(); }
});

test('Jev error categories never expose upstream bodies or follow redirects', async () => {
  const f = await setup(1);
  try {
    for (const [status, expected] of [[401, 503], [403, 503], [302, 502], [500, 502], [429, 429]] as const) {
      const restore = mockFetch(() => new Response('private-provider-detail', { status, headers: { 'retry-after': '120', location: 'https://wrong.test/' } }));
      try {
        const response = await f.request({ query: 'バス' });
        assert.equal(response.status, expected);
        assert.doesNotMatch(await response.text(), /private-provider-detail|test-jev-secret/);
      } finally { restore(); }
    }
  } finally { f.sqlite.close(); }
});

test('public visibility is applied before sending candidates to Jev', async () => {
  const f = await setup(1);
  f.env.PUBLIC_SEARCH_RATE_LIMIT = { limit: async () => ({ success: true }) } as unknown as RateLimit;
  f.sqlite.exec("INSERT INTO repositories(repo,description,default_branch) VALUES('TrainLCD/Private','Private','main')");
  await saveSource(f.env, { id: 'private', repo: 'TrainLCD/Private', kind: 'doc', title: 'SECRET', body: 'バスの非公開計画', url: 'https://example.test/private', metadata: {}, updated_at: 'today' });
  const restore = mockFetch((url, init) => {
    if (url.startsWith('https://api.github.com/')) return Response.json([{ full_name: 'TrainLCD/App', private: false, visibility: 'public' }]);
    const body = JSON.parse(String(init?.body));
    assert.doesNotMatch(JSON.stringify(body), /SECRET|非公開計画/);
    return Response.json(decisions(body));
  });
  try {
    const response = await worker.fetch!(new Request('https://example.test/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'バス対応の網羅率' }) }), f.env, {} as ExecutionContext);
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /SECRET|非公開計画/);
  } finally { restore(); f.sqlite.close(); }
});

test('answer SSE keeps semantic sources even when generation is unavailable', async () => {
  const f = await setup(1);
  const restore = mockFetch((_url, init) => Response.json(decisions(JSON.parse(String(init?.body)))));
  try {
    const response = await f.request({ query: 'バス対応の網羅率' }, '/answer', true);
    assert.equal(response.status, 200);
    const wire = await response.text();
    assert.ok(wire.indexOf('event: sources') >= 0);
    assert.ok(wire.indexOf('event: sources') < wire.indexOf('event: result'));
    const result = JSON.parse(wire.split('event: result\ndata: ')[1]!.trim());
    assert.equal(result.hit_count, 2);
    assert.equal(result.status, 'generation_unavailable');
    assert.equal(result.retrieval, 'jev-semantic-v1');
  } finally { restore(); f.sqlite.close(); }
});

test('empty-result expansion reuses document decisions and still returns a legitimate empty result', async () => {
  const f = await setup();
  let screenedDocuments = 0;
  let scoredPassages = 0;
  const restore = mockFetch((_url, init) => {
    const body = JSON.parse(String(init?.body));
    const entries = Object.keys(body.state.candidates);
    const documentStage = Object.values<any>(body.questions)[0].instructions.includes('Could this document');
    if (documentStage) screenedDocuments += entries.length;
    else scoredPassages += entries.length;
    return Response.json({ model: 'jev-1.14.0', answers: Object.fromEntries(entries.map(id => [id, { type: 'noul', noul: 0.01 }])), usage: { input_tokens: 10, output_tokens: 1 } });
  });
  try {
    const response = await f.request({ query: '資料にない話題' });
    assert.equal(response.status, 200);
    const result: any = await response.json();
    assert.equal(result.status, 'empty');
    assert.equal(result.hit_count, 0);
    assert.equal(screenedDocuments, 43, 'Each document must be screened only once');
    assert.equal(scoredPassages, 2 * (30 + 43), 'The wider scan must judge the title and body units of each passage');
    assert.equal(result.trace.filter((t: any) => t.stage === 'document_screening').length, 1);
  } finally { restore(); f.sqlite.close(); }
});

test('large candidate descriptions fail during collection before sending any model request', async () => {
  const f = await setup(0);
  const insert = f.sqlite.prepare("INSERT INTO sources(id,repo,kind,title,url,body,metadata,updated_at) VALUES(?,'TrainLCD/App','doc','長い文書','https://example.test',?,'{}','2026-11-15')");
  const body = '文'.repeat(4000);
  f.sqlite.exec('BEGIN');
  for (let i = 0; i < 1000; i++) insert.run(`large${i}`, body);
  f.sqlite.exec('COMMIT');
  let calls = 0;
  const restore = mockFetch(() => { calls++; throw Error('must reject before inference'); });
  try {
    const response = await f.request({ query: '文書の網羅率' });
    assert.equal(response.status, 422);
    assert.equal((await response.json() as any).error, 'decision_candidate_budget_exceeded');
    assert.equal(calls, 0);
  } finally { restore(); f.sqlite.close(); }
});
