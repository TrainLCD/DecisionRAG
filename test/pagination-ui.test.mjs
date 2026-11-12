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
  test(`${transport}: yellow matches preserve Markdown, Unicode, safety and page snapshots`, async () => {
    const payload = result(11);
    for (const item of payload.evidence) Object.assign(item, {
      text: 'GPS 位置更新',
      text_html: '<p>ＧＰＳ 位置<strong>更新</strong> gps_tracker svgps 😀 ガ</p><p><a href="https://example.test/GPS">GPS</a> <code>GPS</code></p><pre><code>GPS</code></pre><p>unrelated</p><script>GPS</script><a href="javascript:alert(1)">GPS</a>',
      highlight_terms: ['gps', '位置更新', '位置', 'ガ'],
    });
    const c = client(() => transport === 'json' ? Response.json(payload) : new Response(
      `event: sources\ndata: ${JSON.stringify(payload)}\n\nevent: result\ndata: ${JSON.stringify(payload)}\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } },
    ));
    try {
      c.submit(transport === 'sse');
      await until(() => !c.$('search-button').disabled);
      const check = () => {
        const body = c.window.document.querySelector('.evidence-excerpt');
        assert.deepEqual([...body.querySelectorAll('mark')].map(n => n.textContent), ['ＧＰＳ', '位置', '更新', 'ガ', 'GPS', 'GPS', 'GPS', 'GPS']);
        assert.equal(body.querySelector('strong mark').textContent, '更新');
        assert.equal(body.querySelector('a').href, 'https://example.test/GPS');
        assert.equal(body.querySelector('pre code mark').textContent, 'GPS');
        assert.match(body.textContent, /gps_tracker svgps 😀/);
        assert.equal(body.querySelector('script, [href^="javascript:"], mark mark'), null);
        assert.equal(body.querySelectorAll('mark.search-match').length, 8);
      };
      check();
      c.$('query').value = 'edited but not submitted';
      c.navs()[0].querySelector('[data-page-step="1"]').click();
      check();
      c.navs()[0].querySelector('[data-page-step="-1"]').click();
      check();
      assert.equal(c.requests.length, 1);
    } finally { c.close(); }
  });
}
test('plain text fallback highlights safely; absent terms leave content unchanged', async () => {
  const payload = result(2);
  payload.evidence[0].text = '<img src=x onerror=alert(1)> GPS';
  payload.evidence[0].highlight_terms = ['gps'];
  const c = client(() => Response.json(payload));
  try {
    c.submit();
    await until(() => !c.$('search-button').disabled);
    const bodies = c.window.document.querySelectorAll('.evidence-excerpt');
    assert.equal(bodies[0].querySelector('mark').textContent, 'GPS');
    assert.equal(bodies[0].querySelector('img'), null);
    assert.equal(bodies[1].querySelector('mark'), null);
  } finally { c.close(); }
});

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

test('streaming and final summaries use sanitized Markdown with safe citation links', async () => {
  let controller;
  const c = client(() => new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const markup = '<h2>変更点</h2><ul><li><strong>GPS</strong>と<code>更新</code> [p1]</li></ul><a href="javascript:alert(1)">危険</a><script>alert(1)</script>';
  const text = '## 変更点\n- **GPS**と`更新` [p1]';
  const emit = (event, data) => controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  const check = () => {
    const panel = c.$('answer-panel');
    assert.equal(panel.querySelector('h2').textContent, '変更点');
    assert.equal(panel.querySelector('li strong').textContent, 'GPS');
    assert.equal(panel.querySelector('li code').textContent, '更新');
    assert.equal(panel.querySelector('li a').getAttribute('href'), '#evidence-p1');
    assert.equal(panel.querySelector('script, [href^="javascript:"]'), null);
    assert.doesNotMatch(panel.textContent, /\*\*GPS\*\*/);
  };
  try {
    c.submit(true);
    await until(() => !!controller);
    emit('sources', result(1));
    emit('draft', { answer: ['回答'], summaries: [text], summaries_html: [markup] });
    await until(() => !!c.$('answer-panel').querySelector('h2'));
    check();
    emit('result', { ...result(1), status: 'summarized', answer: '回答 [p1]', answer_html: '<p>回答 [p1]</p>', ticket_summaries: [{ source_id: 'source-0', text, text_html: markup }] });
    controller.close();
    await until(() => !c.$('search-button').disabled);
    check();
    assert.doesNotMatch(c.$('answer-panel').textContent, /生成中/);
  } finally { c.close(); }
});
