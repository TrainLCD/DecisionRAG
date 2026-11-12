import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync('public/index.html', 'utf8');
const app = readFileSync('public/app.js', 'utf8');
const evidence = count => Array.from({ length: count }, (_, i) => ({
  id: `passage-${i}`, source_id: `source-${i}`, citation: `p${i + 1}`,
  kind: 'issue', title: `Issue ${i}`, text: `Passage ${i}`, repo: 'TrainLCD/App', metadata: {},
  url: `https://github.com/TrainLCD/App/issues/${i + 1}`,
}));
const result = count => ({ status: count ? 'retrieved' : 'empty', evidence: evidence(count), hit_count: count, elapsed_ms: 100 });

function client(respond) {
  const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only' });
  const { window } = dom;
  const requests = [];
  window.TextDecoder = TextDecoder;
  window.fetch = async (path, options) => {
    requests.push({ path, body: JSON.parse(options.body), headers: options.headers });
    return respond(path, options);
  };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.eval(app);
  const $ = id => window.document.getElementById(id);
  return { window, requests, $, close: () => window.close(),
    submit(summary = false) {
      $('query').value = 'test query';
      $('include-summary').checked = summary;
      $('search-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    },
    navs: () => [...window.document.querySelectorAll('.result-pagination')],
    cards: () => [...window.document.querySelectorAll('.evidence-card')].map(card => card.id),
  };
}
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('UI did not reach the expected state');
}
function expectPage(c, page, count) {
  const start = page * 10, end = Math.min(start + 10, count);
  assert.deepEqual(c.cards(), evidence(count).slice(start, end).map(item => 'evidence-' + item.citation));
  for (const nav of c.navs()) {
    assert.equal(nav.hidden, count <= 10);
    assert.equal(nav.querySelector('[data-page-label]').textContent, count
      ? `${page + 1} / ${Math.ceil(count / 10)}ページ（${start + 1}〜${end}件 / ${count}件）` : '');
    assert.equal(nav.querySelector('[data-page-step="-1"]').disabled, page === 0);
    assert.equal(nav.querySelector('[data-page-step="1"]').disabled, page + 1 >= Math.ceil(count / 10));
  }
  assert.match(c.$('result-summary').textContent, new RegExp(`関連する本文：${count}件`));
}

for (const count of [0, 1, 9, 10, 11, 20, 21, 40, 41, 151]) {
  test(`${count} hits: full totals, exact slices, no duplicate/missing passages or page requests`, async () => {
    const c = client(() => Response.json(result(count)));
    try {
      c.submit();
      await until(() => !c.$('search-button').disabled);
      assert.deepEqual(c.requests.map(r => [r.path, r.body]), [['/search', { query: 'test query', include_feedback: false }]]);
      const seen = [];
      const pages = Math.max(1, Math.ceil(count / 10));
      for (let page = 0; page < pages; page++) {
        expectPage(c, page, count);
        seen.push(...c.cards());
        c.navs()[page % c.navs().length].querySelector('[data-page-step="1"]').click();
      }
      assert.deepEqual(seen, evidence(count).map(item => 'evidence-' + item.citation));
      for (let page = pages - 1; page >= 0; page--) {
        expectPage(c, page, count);
        c.navs()[0].querySelector('[data-page-step="-1"]').click();
      }
      assert.equal(c.requests.length, 1, 'page navigation must reuse the same search snapshot');
    } finally { c.close(); }
  });
}

test('new search resets the page and replaces all previous hits', async () => {
  let count = 41;
  const c = client(() => Response.json(result(count)));
  try {
    c.submit();
    await until(() => !c.$('search-button').disabled);
    c.navs()[0].querySelector('[data-page-step="1"]').click();
    expectPage(c, 1, 41);
    count = 11;
    c.submit();
    await until(() => !c.$('search-button').disabled);
    expectPage(c, 0, 11);
    assert.equal(c.requests.length, 2);
  } finally { c.close(); }
});

test('answer stream exposes full hits before completion and preserves them through draft and result', async () => {
  let controller;
  const c = client(() => new Response(new ReadableStream({ start(value) { controller = value; } }),
    { headers: { 'Content-Type': 'text/event-stream' } }));
  const send = (event, data) => controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  try {
    c.submit(true);
    assert.deepEqual(c.requests[0].body, { query: 'test query', include_feedback: false });
    assert.equal(c.requests[0].path, '/answer');
    assert.equal(c.requests[0].headers.Accept, 'text/event-stream');
    send('sources', result(41));
    await until(() => c.cards().length === 10);
    expectPage(c, 0, 41);
    assert.equal(c.$('search-button').disabled, true);
    send('draft', { answer: ['Partial answer'], summaries: [] });
    await until(() => c.$('answer-panel').textContent.includes('Partial answer'));
    expectPage(c, 0, 41);
    assert.ok(c.$('answer-panel').textContent.startsWith('生成中質問への回答'));
    send('result', { ...result(41), status: 'summarized', answer: 'See [p41].' });
    controller.close();
    await until(() => !c.$('search-button').disabled);
    expectPage(c, 0, 41);
    c.$('answer-panel').querySelector('a[href="#evidence-p41"]').click();
    expectPage(c, 4, 41);
    assert.equal(c.window.document.activeElement.id, 'evidence-p41');
    assert.equal(c.requests.length, 1);
  } finally { c.close(); }
});

for (const transport of ['json', 'sse']) {
  test(`${transport} timing breakdown renders local decisions and the actual stage metrics`, async () => {
    let data = {
      ...result(1), status: 'summarized',
      timings: { scope_ms: 813, storage_ms: 122, model_ms: 784, generation_ms: 11130 },
      trace: [
        { stage: 'document_screening', candidates: 3342, calls: 0, elapsed_ms: 784, model: ['rust-rules-v1'] },
        { stage: 'passage_scoring', candidates: 472, calls: 0, elapsed_ms: 0, model: ['rust-rules-v1'] },
        { stage: 'generate_answer', candidates: 20, calls: 1, elapsed_ms: 11130, model: ['@cf/google/gemma-4-26b-a4b-it'] },
        { stage: 'verify_answer', candidates: 4, calls: 0, elapsed_ms: 0, model: ['rust-rules-v1'] },
      ],
    };
    const c = client(() => transport === 'json' ? Response.json(data) : new Response(
      `event: sources\ndata: ${JSON.stringify(result(1))}\n\nevent: result\ndata: ${JSON.stringify(data)}\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } },
    ));
    const rows = () => [...c.$('trace-list').querySelectorAll('.trace-row')].map(row =>
      [row.firstChild.textContent, row.querySelector('span').textContent]);
    try {
      c.submit(transport === 'sse');
      await until(() => !c.$('search-button').disabled);
      assert.equal(c.$('trace-panel').hidden, false);
      assert.deepEqual(rows(), [
        ['所要時間の内訳', '公開範囲の確認 813 ms / DB取得 122 ms / ローカル判定 784 ms / 要約生成 11,130 ms'],
        ['文書の選択', '候補 3,342 · API 0 回 · 784 ms · rust-rules-v1'],
        ['本文の評価', '候補 472 · API 0 回 · 0 ms · rust-rules-v1'],
        ['要約の生成', '候補 20 · API 1 回 · 11,130 ms · @cf/google/gemma-4-26b-a4b-it'],
        ['回答の検証', '候補 4 · API 0 回 · 0 ms · rust-rules-v1'],
      ]);
      assert.doesNotMatch(c.$('trace-panel').textContent, /clef/i);

      // A subsequent search must replace old timings and retain meaningful zeros.
      data = { ...result(1), timings: { scope_ms: 0, storage_ms: 0, model_ms: 0, generation_ms: 0 },
        trace: [{ stage: 'document_screening', candidates: 0, calls: 0, elapsed_ms: 0, model: ['rust-rules-v1'] }] };
      c.submit(transport === 'sse');
      await until(() => !c.$('search-button').disabled);
      assert.deepEqual(rows(), [
        ['所要時間の内訳', 'DB取得 0 ms / ローカル判定 0 ms'],
        ['文書の選択', '候補 0 · API 0 回 · 0 ms · rust-rules-v1'],
      ]);
    } finally { c.close(); }
  });
}

for (const transport of ['json', 'sse']) {
  test(`${transport}: final paraphrased answer remains visible before ticket summaries`, async () => {
    const payload = { ...result(1), status: 'summarized', answer: 'GPS位置情報の更新を修正しています。 [p1]', ticket_summaries: [{ source_id: 'source-0', text: '位置情報の更新処理を修正。', citations: ['p1'] }], verification: { semantic_status: 'unknown' } };
    const c = client(() => transport === 'json' ? Response.json(payload) : new Response(`event: sources\ndata: ${JSON.stringify(payload)}\n\nevent: draft\ndata: ${JSON.stringify({ answer: ['GPS位置情報の更新を修正しています。'], summaries: [] })}\n\nevent: result\ndata: ${JSON.stringify(payload)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }));
    try {
      c.submit(true);
      await until(() => !c.$('search-button').disabled);
      const panel = c.$('answer-panel');
      assert.match(panel.textContent, /質問への回答GPS位置情報の更新を修正しています/);
      assert.doesNotMatch(panel.textContent, /資料から質問への回答を確認できませんでした/);
      assert.ok(panel.textContent.indexOf('GPS位置情報') < panel.textContent.indexOf('各チケットの要約'));
      assert.equal(panel.querySelector('a').getAttribute('href'), '#evidence-p1');
    } finally { c.close(); }
  });
}
