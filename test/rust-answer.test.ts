import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { fixture } from './helpers.js';
import { saveSource } from './reference/store.js';

for (const stream of [false, true]) {
  for (const scenario of [
    { name: 'supported paraphrase', source: 'GPS位置情報を更新する処理を修正した。', text: 'GPS位置情報の更新を修正しています。', accepted: true },
    { name: 'related paraphrase with unknown entailment', source: '背景で新しい測位が10秒以上届かない場合だけ、別の背景対応CLLocationManagerで補完します。', text: 'iOSでは、背景での通常測位が10秒以上途絶した場合にのみ、別のCLLocationManagerを使用して補完測位を開始する仕組みになっています。', accepted: true },
    { name: 'negation reversal', source: 'バックグラウンドではGPS位置情報を更新しない。', text: 'バックグラウンドではGPS位置情報を更新する。', accepted: false },
    { name: 'invented release', source: 'GPS位置情報を更新する処理を修正した。', text: 'GPS位置情報の更新修正をApp Storeで配信済みです。', accepted: false },
  ]) {
    test(`Rust ${stream ? 'SSE' : 'JSON'} final answer: ${scenario.name}`, async () => {
      const f = fixture();
      try {
        f.sqlite.exec("INSERT INTO repositories(repo,description,default_branch) VALUES('TrainLCD/App','App','main')");
        await saveSource(f.env, { id: 'doc', repo: 'TrainLCD/App', kind: 'doc', title: 'GPS位置情報', body: scenario.source, url: 'https://example.test', metadata: {}, updated_at: '2026-11-12' });
        f.env.AI = { run: async (_model: string, input: any) => {
          const user = JSON.parse(input.messages[1].content.split('\n\n')[0]);
          const citation = user.evidence[0].citation;
          const content = JSON.stringify({ claims: [{ text: scenario.text, citations: [citation] }], summaries: [{ source_id: 'doc', text: scenario.text, citations: [citation] }] });
          if (!stream) return { choices: [{ message: { content } }] };
          return new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`));
            controller.close();
          } });
        } } as unknown as Ai;
        const response = await worker.fetch!(new Request('https://example.test/answer', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + f.env.API_TOKEN, ...(stream ? { Accept: 'text/event-stream' } : {}) }, body: JSON.stringify({ query: 'GPS' }) }), f.env, {} as ExecutionContext);
        assert.equal(response.status, 200);
        let result: any;
        if (stream) {
          const wire = await response.text();
          assert.match(wire, /event: draft/);
          result = JSON.parse(wire.split('event: result\ndata: ')[1]!.trim());
        } else result = await response.json();
        if (scenario.accepted) {
          assert.ok(result.answer?.includes(scenario.text), JSON.stringify(result));
          assert.equal(result.ticket_summaries[0].text, scenario.text);
          assert.equal(result.verification.semantic_status, 'unknown');
          assert.ok(result.trace.filter((t: any) => t.stage !== 'generate_answer').every((t: any) => t.calls === 0));
        } else assert.equal(result.answer, null);
      } finally { f.sqlite.close(); }
    });
  }
}
