import test from 'node:test';
import assert from 'node:assert/strict';
import { collectGeneration, draftPreview, readSse } from './reference/stream.js';
import { answer } from './reference/answer.js';
import type { Env } from './reference/types.js';
import type { Judge } from './legacy-judge.js';

const encoder = new TextEncoder();
const frame = (content: string) => 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\r\n\r\n';

test('partial JSON preview handles escaped quotes, Unicode and prose resembling JSON keys', () => {
  assert.deepEqual(draftPreview('{"claims":[{"text":"東京'), { answer: ['東京'], summaries: [] });
  assert.deepEqual(draftPreview('{"claims":[{"text":"a\\u30'), { answer: ['a'], summaries: [] });
  const draft = { claims: [{ text: '"summaries": "text": 日本語\n引用\\' }], summaries: [{ text: '要約' }] };
  assert.deepEqual(draftPreview(JSON.stringify(draft)), { answer: [draft.claims[0]!.text], summaries: ['要約'] });
});

test('provider tokens reach the caller before generation completes, across single-byte chunks', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  let first!: () => void;
  const received = new Promise<void>(resolve => { first = resolve; });
  const previews: ReturnType<typeof draftPreview>[] = [];
  let finished = false;
  const result = collectGeneration(stream, new AbortController().signal, preview => {
    previews.push(preview); if (preview.answer[0] === '東京') first();
  }).then(value => { finished = true; return value; });
  for (const byte of encoder.encode(frame('{"claims":[{"text":"東京'))) controller.enqueue(Uint8Array.of(byte));
  await received;
  assert.equal(finished, false);
  controller.enqueue(encoder.encode(frame('の報告","citations":["p1"]}],"summaries":[]}') + 'data: [DONE]\n\n'));
  controller.close();
  const completed = await result;
  assert.equal(JSON.parse(completed.choices[0]!.message.content).claims[0].text, '東京の報告');
  assert.equal(previews.at(-1)?.answer[0], '東京の報告');
});

test('truncated and errored upstream streams are rejected; abort cancels the reader', async () => {
  await assert.rejects(collectGeneration(new Response(frame('{}')).body!, new AbortController().signal, () => {}), /incomplete_generation_stream/);
  await assert.rejects(collectGeneration(new Response('data: {"error":"private details"}\n\n').body!, new AbortController().signal, () => {}), /generation_unavailable/);
  let cancelled = false;
  const abort = new AbortController();
  const pending = readSse(new ReadableStream({ cancel() { cancelled = true; } }), abort.signal, () => {});
  abort.abort();
  await assert.rejects(pending);
  assert.equal(cancelled, true);
});

test('streamed provisional claims still pass through verification and can be withheld', async () => {
  let streamed = false, verified = false;
  const env = { AI: { async run(_model: string, input: { stream?: boolean }) {
    assert.equal(input.stream, true);
    return new Response(frame('{"claims":[{"text":"Unsupported","citations":["p1"]}],"summaries":[]}') + 'data: [DONE]\n\n').body;
  } } } as unknown as Env;
  const judge = { trace: [], async verify() {
    assert.equal(streamed, true); verified = true;
    return { claims: [0], complete: 0, conflict: 0 };
  } } as unknown as Judge;
  const result = await answer('query', [{ id: '1', source_id: 'a', ordinal: 0, text: 'source', title: 'source',
    repo: 'TrainLCD/Issues', kind: 'feedback', metadata: {}, updated_at: '', url: '', citation: 'p1', relevance: 1 }],
  env, judge, () => { streamed = true; });
  assert.equal(verified, true);
  assert.equal(result.status, 'verification_failed');
  assert.equal(result.answer, null);
});

test('preview updates are throttled with a final flush; preview failures cannot discard generation', async (t) => {
  t.mock.method(Date, 'now', () => 1000);
  const parts = ['{"claims":[{"text":"a', 'b', 'c', 'd', '","citations":["p1"]}],"summaries":[]}'];
  let i = 0;
  const previews: ReturnType<typeof draftPreview>[] = [];
  let doneRequested!: () => void, releaseDone!: () => void;
  const waitingForDone = new Promise<void>(resolve => { doneRequested = resolve; });
  const allowDone = new Promise<void>(resolve => { releaseDone = resolve; });
  const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
    if (i < parts.length) controller.enqueue(encoder.encode(frame(parts[i++]!)));
    else {
      doneRequested();
      await allowDone;
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  } });
  const pending = collectGeneration(stream, new AbortController().signal, preview => {
    previews.push(preview);
    throw new Error('Preview unavailable');
  });
  await waitingForDone;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(previews, [{ answer: ['a'], summaries: [] }]);
  releaseDone();
  const result = await pending;
  assert.equal(previews.length, 2);
  assert.deepEqual(previews[1], { answer: ['abcd'], summaries: [] });
  assert.equal(JSON.parse(result.choices[0]!.message.content).claims[0].text, 'abcd');
});
