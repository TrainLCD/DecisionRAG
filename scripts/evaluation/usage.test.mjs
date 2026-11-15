import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageLedger } from './usage.mjs';

test('partial success followed by an unknown failure preserves measured usage', async () => {
  const ledger = new UsageLedger();
  const body = { usage: { input_tokens: 123, output_tokens: 7 }, answers: {} };
  const response = Response.json(body);
  await ledger.response(response);
  assert.deepEqual(await response.json(), body, 'measurement must not consume the engine response');
  await ledger.response(new Response('unavailable', { status: 500 }));
  assert.deepEqual(ledger.snapshot(), { provider_calls: 2, provider_statuses: { 200: 1, 500: 1 }, usage_unknown_calls: 1,
    observed_input_tokens: 123, observed_output_tokens: 7, input_tokens: null, output_tokens: null });
});

test('network failure is unknown; no actual calls means measured zero', () => {
  const ledger = new UsageLedger();
  assert.equal(ledger.snapshot().input_tokens, 0);
  ledger.failure();
  assert.equal(ledger.snapshot().input_tokens, null);
  assert.equal(ledger.snapshot().usage_unknown_calls, 1);
});

test('complete real usage remains numeric, malformed usage is unknown', async () => {
  const ledger = new UsageLedger();
  await ledger.response(Response.json({ usage: { input_tokens: 10, output_tokens: 3 } }));
  await ledger.response(Response.json({ usage: { input_tokens: 20, output_tokens: 2 } }));
  assert.equal(ledger.snapshot().input_tokens, 30);
  await ledger.response(Response.json({ usage: { input_tokens: -1, output_tokens: 0 } }));
  assert.equal(ledger.snapshot().input_tokens, null);
  assert.equal(ledger.snapshot().observed_input_tokens, 30);
});
