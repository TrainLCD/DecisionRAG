import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const app = readFileSync('public/app.js', 'utf8');
const code = app.slice(app.indexOf('async function readAnswerStream('), app.indexOf('/** Show provisional prose'));
const read = vm.runInNewContext(code + '\nreadAnswerStream', { TextDecoder, errors: {} });

test('client displays draft events before result and rejects premature EOF', async () => {
  let controller;
  const response = new Response(new ReadableStream({ start(c) { controller = c; } }));
  const enc = new TextEncoder();
  let sawDraft;
  const seen = new Promise(resolve => { sawDraft = resolve; });
  const result = read(response, (event, data) => { assert.equal(event, 'draft'); assert.equal(data.answer[0], '東京'); sawDraft(); });
  for (const byte of enc.encode('event: draft\r\ndata: {"answer":["東京"]}\r\n\r\n')) controller.enqueue(Uint8Array.of(byte));
  await seen;
  controller.enqueue(enc.encode('event: result\ndata: {"status":"verification_failed","answer":null}\n\n'));
  assert.equal((await result).status, 'verification_failed');
  await assert.rejects(read(new Response('event: draft\ndata: {}\n\n'), () => {}), /途中で切れ/);
  await assert.rejects(read(new Response('event: error\ndata: {"error":"private"}\n\n'), () => {}), /生成に失敗/);
});
