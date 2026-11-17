import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { fixture, mockFetch } from './helpers.js';
import { saveSource } from './reference/store.js';

// These tests verify the Rust/WASM handoff and failure contract, not Jev's semantic accuracy.
for (const stream of [false, true]) {
  for (const scenario of ['selected', 'empty', 'unavailable', 'unknown-id']) {
    test(`answer evidence ${stream ? 'SSE' : 'JSON'}: ${scenario}`, async () => {
      const f = fixture();
      f.env.ANSWER_CONTEXT_ENGINE = 'jev';
      f.env.TYPESAFE_API_KEY = 'test-jev-key';
      let generations = 0;
      const restore = mockFetch((_url, init) => {
        assert.equal(_url, 'https://api.typesafe.ai/v1/systemone');
        const request = JSON.parse(String(init?.body));
        assert.equal(request.state.query, 'GPS位置更新が止まる問題');
        if (scenario === 'unavailable') return new Response('{}', { status: 401 });
        const answers = Object.fromEntries(Object.entries(request.state.candidates).map(([key, text]) => [key, {
          type: 'noul', noul: scenario === 'empty' ? 0.1 : JSON.parse(String(text)).source_id === 'direct' ? 0.95 : 0.1,
        }]));
        if (scenario === 'unknown-id') {
          answers.extra = answers.c0!;
          delete answers.c0;
        }
        return Response.json({ model: 'jev-1.14.0', usage: { input_tokens: 10, output_tokens: 0 }, answers });
      });
      try {
        f.sqlite.exec("INSERT INTO repositories(repo,description,default_branch) VALUES('TrainLCD/App','App','main')");
        for (const [id, text] of [['direct', 'GPS位置更新が止まる問題を修正しました。'], ['example', '検索の入力例にGPS位置更新が止まる問題を使います。']]) {
          await saveSource(f.env, { id: id!, repo: 'TrainLCD/App', kind: 'doc', title: 'GPS位置更新が止まる問題', body: text!, url: 'https://example.test/' + id, metadata: {}, updated_at: '2026-11-16' });
        }
        f.env.AI = { run: async (_model: string, input: any) => {
          generations++;
          const payload = JSON.parse(input.messages[1].content.split('\n\n')[0]);
          assert.deepEqual(payload.evidence.map((p: any) => p.source_id), ['direct']);
          assert.equal(payload.evidence_scope.retrieved_passages, 2);
          assert.equal(payload.evidence_scope.included_passages, 1);
          const content = JSON.stringify({ claims: [{ text: 'GPS位置更新が止まる問題を修正しました。', citations: [payload.evidence[0].citation] }] });
          if (!stream) return { choices: [{ message: { content } }] };
          return new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`));
            controller.close();
          } });
        } } as unknown as Ai;
        const response = await worker.fetch!(new Request('https://example.test/answer', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + f.env.API_TOKEN, ...(stream ? { Accept: 'text/event-stream' } : {}) },
          body: JSON.stringify({ query: 'GPS位置更新が止まる問題' }),
        }), f.env, {} as ExecutionContext);
        const wire = await response.text();
        if (scenario === 'unavailable' || scenario === 'unknown-id') {
          assert.equal(generations, 0);
          assert.ok(wire.includes(scenario === 'unavailable' ? 'jev_authentication_failed' : 'invalid_jev_answers'), wire);
          assert.ok(!wire.includes('insufficient_evidence'));
          if (stream) assert.ok(wire.includes('event: sources'));
        } else {
          assert.equal(response.status, 200);
          const result = stream ? JSON.parse(wire.split('event: result\ndata: ')[1]!.trim()) : JSON.parse(wire);
          assert.equal(result.evidence.length, 2, 'filtering answer inputs must not remove search results');
          assert.equal(result.hit_count, 2);
          assert.equal(generations, scenario === 'selected' ? 1 : 0);
          if (scenario === 'selected') {
            assert.ok(result.answer.includes('修正しました'));
            assert.ok(result.trace.some((t: any) => t.stage === 'answer_evidence' && t.calls > 0));
          } else {
            assert.equal(result.answer, null);
            assert.equal(result.status, 'insufficient_evidence');
          }
        }
      } finally { restore(); f.sqlite.close(); }
    });
  }
}
