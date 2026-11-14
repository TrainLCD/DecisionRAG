import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { fixture } from './helpers.js';
import { saveSource } from './reference/store.js';

for (const stream of [false, true]) {
  for (const scenario of [
    { name: 'Markdown paraphrase', source: 'GPS位置情報を更新する処理を修正した。', text: '**GPS位置情報**の更新を修正しています。', accepted: true },
    { name: 'supported paraphrase', source: 'GPS位置情報を更新する処理を修正した。', text: 'GPS位置情報の更新を修正しています。', accepted: true },
    { name: 'related paraphrase with unknown entailment', source: '背景で新しい測位が10秒以上届かない場合だけ、別の背景対応CLLocationManagerで補完します。', text: 'iOSでは、背景での通常測位が10秒以上途絶した場合にのみ、別のCLLocationManagerを使用して補完測位を開始する仕組みになっています。', accepted: true },
    { name: 'historical-only current scope', kind: 'pr', source: 'GPS位置情報はiOSのみに対応しています。', text: 'GPS位置情報はiOSのみに対応しています。', accepted: false },
    { name: 'document-backed current scope', kind: 'doc', source: 'GPS位置情報はiOSのみに対応しています。', text: 'GPS位置情報はiOSのみに対応しています。', accepted: true },
    { name: 'negation reversal', source: 'バックグラウンドではGPS位置情報を更新しない。', text: 'バックグラウンドではGPS位置情報を更新する。', accepted: false },
    { name: 'invented release', source: 'GPS位置情報を更新する処理を修正した。', text: 'GPS位置情報の更新修正をApp Storeで配信済みです。', accepted: false },
  ]) {
    test(`Rust ${stream ? 'SSE' : 'JSON'} final answer: ${scenario.name}`, async () => {
      const f = fixture();
      try {
        f.sqlite.exec("INSERT INTO repositories(repo,description,default_branch) VALUES('TrainLCD/App','App','main')");
        await saveSource(f.env, { id: 'doc', repo: 'TrainLCD/App', kind: (scenario.kind ?? 'doc') as 'doc' | 'pr', title: 'GPS位置情報', body: scenario.source, url: 'https://example.test', metadata: {}, updated_at: '2026-11-12' });
        f.env.AI = { run: async (_model: string, input: any) => {
          assert.deepEqual(input.response_format.json_schema.schema.required, ['claims']);
          assert.equal(input.response_format.json_schema.schema.properties.summaries, undefined);
          const user = JSON.parse(input.messages[1].content.split('\n\n')[0]);
          assert.equal(user.evidence[0].updated_at, '2026-11-12');
          assert.deepEqual(user.evidence_scope, { retrieved_passages: 1, included_passages: 1, exhaustive: false });
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
          const preview = JSON.parse(wire.split('event: draft\ndata: ')[1]!.split('\n\n')[0]!);
          assert.equal(preview.summaries, undefined);
          if (scenario.name === 'historical-only current scope') assert.deepEqual(preview.answer, []);
          result = JSON.parse(wire.split('event: result\ndata: ')[1]!.trim());
        } else result = await response.json();
        if (scenario.accepted) {
          assert.ok(result.answer?.includes(scenario.text), JSON.stringify(result));
          assert.equal(result.ticket_summaries, undefined);
          assert.equal(typeof result.answer_html, 'string');
          if (scenario.name === 'Markdown paraphrase') {
            assert.match(result.answer_html, /<strong>GPS位置情報<\/strong>/);
          }
          assert.equal(result.verification.semantic_status, 'unknown');
          assert.ok(result.trace.filter((t: any) => t.stage !== 'generate_answer').every((t: any) => t.calls === 0));
        } else assert.equal(result.answer, null);
      } finally { f.sqlite.close(); }
    });
  }
}

for (const stream of [false, true]) {
  for (const failure of ['missing binding', 'provider error', 'empty claims', 'summary only']) {
    test(`Rust ${stream ? 'SSE' : 'JSON'} ${failure} returns sources without summaries`, async () => {
      const f = fixture();
      try {
        f.sqlite.exec("INSERT INTO repositories(repo,description,default_branch) VALUES('TrainLCD/App','App','main')");
        await saveSource(f.env, { id: 'doc', repo: 'TrainLCD/App', kind: 'doc', title: 'GPS位置情報', body: 'GPS位置情報の更新を修正した。', url: 'https://example.test', metadata: {}, updated_at: '2026-11-13' });
        let calls = 0;
        f.env.AI = failure === 'missing binding' ? undefined : { run: async () => {
          calls++;
          if (failure === 'provider error') throw new Error('unavailable');
          const content = JSON.stringify({ claims: [], ...(failure === 'summary only' ? { summaries: [{ source_id: 'doc', text: 'GPS位置情報の更新を修正した。', citations: ['p1'] }] } : {}) });
          if (!stream) return { choices: [{ message: { content } }] };
          return new ReadableStream({ start(c) {
            c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`));
            c.close();
          } });
        } } as unknown as Ai;
        const response = await worker.fetch!(new Request('https://example.test/answer', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + f.env.API_TOKEN, ...(stream ? { Accept: 'text/event-stream' } : {}) }, body: JSON.stringify({ query: 'GPS' }) }), f.env, {} as ExecutionContext);
        assert.equal(response.status, 200);
        const result: any = stream ? JSON.parse((await response.text()).split('event: result\ndata: ')[1]!.trim()) : await response.json();
        assert.equal(result.status, 'generation_unavailable');
        assert.equal(result.answer, null);
        assert.equal(result.ticket_summaries, undefined);
        assert.equal(result.evidence.length, 1);
        assert.equal(calls, failure === 'missing binding' ? 0 : 1);
      } finally { f.sqlite.close(); }
    });
  }
}

for (const stream of [false, true]) {
  test(`bus coverage regression removes historical exclusivity and keeps current evidence (${stream ? 'SSE' : 'JSON'})`, async () => {
    const f = fixture();
    const restriction = '路線バスについては、都営バスのみに対応しており、その他の路線には対応していません。';
    const current = 'GTFSフィードの統合機能により、都営バス、西武バス、京王バス、および東急バスが運行するコミュニティバスなどのデータを取り込んでいます。';
    try {
      f.sqlite.exec("INSERT INTO repositories(repo,description,default_branch) VALUES('TrainLCD/App','App','main')");
      for (const source of [
        { id: 'old-pr', kind: 'pr' as const, body: restriction, updated_at: '2026-06-10', metadata: { merged_at: '2026-06-10' } },
        { id: 'current-doc', kind: 'doc' as const, body: current, updated_at: '2026-11-12', metadata: { commit: 'current' } },
      ]) await saveSource(f.env, { ...source, repo: 'TrainLCD/App', title: '路線バス対応', url: 'https://example.test/' + source.id });
      f.env.AI = { run: async (_model: string, input: any) => {
        const context = JSON.parse(input.messages[1].content.split('\n\n')[0]).evidence;
        const content = JSON.stringify({ claims: [
          { text: restriction, citations: [context.find((p: any) => p.source_id === 'old-pr').citation] },
          { text: current, citations: [context.find((p: any) => p.source_id === 'current-doc').citation] },
        ] });
        if (!stream) return { choices: [{ message: { content } }] };
        return new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`));
          controller.close();
        } });
      } } as unknown as Ai;
      const response = await worker.fetch!(new Request('https://example.test/answer', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + f.env.API_TOKEN, ...(stream ? { Accept: 'text/event-stream' } : {}) }, body: JSON.stringify({ query: '路線バスは日本全国に対応していますか？' }) }), f.env, {} as ExecutionContext);
      let result: any;
      if (stream) {
        const wire = await response.text();
        for (const frame of wire.split('\n\n').filter(frame => frame.startsWith('event: draft'))) {
          const draft = JSON.parse(frame.split('\ndata: ')[1]!);
          assert.ok(!draft.answer.join('\n').includes(restriction));
        }
        result = JSON.parse(wire.split('event: result\ndata: ')[1]!.trim());
      } else result = await response.json();
      assert.ok(!result.answer.includes(restriction));
      assert.ok(result.answer.includes(current));
      assert.equal(result.verification.reasons[0], 'current_scope_not_established');
      assert.equal(result.hit_count, 2);
    } finally { f.sqlite.close(); }
  });
}
