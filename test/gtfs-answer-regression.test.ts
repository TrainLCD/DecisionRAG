import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import worker from '../src/index.js';
import { fixture } from './helpers.js';
import { saveSource } from './reference/store.js';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const captured = JSON.parse(readFileSync('test/fixtures/gtfs-answer-regression.json', 'utf8'));

for (const variant of ['draft', 'followup_draft']) {
 const draft = captured[variant];
for (const stream of [false, true]) {
  test(`GTFS ${variant} captured answer survives final verification and ${stream ? 'streaming UI' : 'JSON'} rendering`, async () => {
    const f = fixture();
    let dom: any;
    let finishGeneration: (() => void) | undefined;
    try {
      f.sqlite.exec("INSERT INTO repositories(repo,description,default_branch) VALUES('TrainLCD/StationAPI','StationAPI','main')");
      const source = captured.evidence[0];
      await saveSource(f.env, { id: source.source_id, repo: source.repo, kind: 'doc', title: source.title, body: captured.evidence.map((e: any) => e.text).join('\n\n'), url: source.url, metadata: {}, updated_at: '2026-11-12' });
      f.env.AI = { run: async (_model: string, input: any) => {
        const context = JSON.parse(input.messages[1].content.split('\n\n')[0]).evidence;
        const citations = context.map((e: any) => e.citation);
        assert.ok(citations.length >= 3);
        const content = JSON.stringify({ claims: draft.answer.map((text: string) => ({ text, citations })), summaries: draft.summaries.map((text: string) => ({ source_id: source.source_id, text, citations })) });
        if (!stream) return { choices: [{ message: { content } }] };
        return new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
          finishGeneration = () => {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          };
        } });
      } } as unknown as Ai;
      const response = await worker.fetch!(new Request('https://example.test/answer', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + f.env.API_TOKEN, ...(stream ? { Accept: 'text/event-stream' } : {}) }, body: JSON.stringify({ query: captured.query }) }), f.env, {} as ExecutionContext);
      assert.equal(response.status, 200);
      let result: any;
      if (stream) {
        const wire = response.clone().text();
        dom = new JSDOM(readFileSync('public/index.html', 'utf8'), { url: 'https://example.test/', runScripts: 'outside-only' });
        const { window } = dom;
        window.TextDecoder = TextDecoder;
        window.fetch = async () => response;
        window.HTMLElement.prototype.scrollIntoView = () => {};
        window.eval(readFileSync('public/app.js', 'utf8'));
        const $ = (id: string) => window.document.getElementById(id);
        const until = async (check: () => boolean) => {
          for (let i = 0; i < 400; i++) {
            if (check()) return;
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          assert.fail('GTFS UI did not reach expected state');
        };
        $('query').value = captured.query;
        $('include-summary').checked = true;
        $('search-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
        await until(() => $('answer-panel').textContent.includes('専用のテーブル'));
        assert.match($('answer-panel').textContent, /生成中/);
        finishGeneration!();
        await until(() => !$('search-button').disabled);
        const panel = $('answer-panel');
        for (const text of draft.answer) {
          assert.ok(panel.textContent.includes(text.replaceAll('`', '')), text);
        }
        assert.doesNotMatch(panel.textContent, /回答を確認できませんでした|資料の記載：|生成中/);
        assert.ok(panel.querySelector('code'), 'Markdown remains rendered after final event');
        const replay = await wire;
        result = JSON.parse(replay.split('event: result\ndata: ')[1]!.trim());
        if (variant === 'followup_draft') {
          mkdirSync('test-results', { recursive: true });
          writeFileSync('test-results/gtfs-answer-stream.sse', replay);
        }
      } else result = await response.json();
      for (const text of draft.answer) assert.ok(result.answer?.includes(text), JSON.stringify(result.verification));
      assert.equal(result.ticket_summaries, undefined);
      assert.equal(result.verification.semantic_status, 'unknown');
    } finally { dom?.window.close(); f.sqlite.close(); }
  });
}

}
