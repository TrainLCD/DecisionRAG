import { test } from 'node:test';
import assert from 'node:assert/strict';
import { host } from '../src/host.js';
import { fixture } from './helpers.js';
import type { SyncJob } from '../src/types.js';

test('queue bookkeeping survives an expired upstream signal', async () => {
  const { env, sqlite } = fixture();
  let retried = false;
  const message = { id: 'timeout', body: { type: 'org', page: 1 }, retry() { retried = true; } } as Message<SyncJob>;
  const binding = host(env, { signal: AbortSignal.abort(), messages: [message] });
  try {
    const call = async (op: string, input: unknown) => JSON.parse(await binding.call(op, JSON.stringify(input)));
    assert.equal((await call('fetch', {})).error, 'host_operation_failed');
    assert.ok('value' in await call('db', { sql: 'INSERT INTO sync_jobs(id,job,status,updated_at) VALUES(?,?,?,?)', params: ['timeout', '{}', 'retrying', 'now'] }));
    assert.ok('value' in await call('retry', { index: 0, delaySeconds: 30 }));
    assert.equal(retried, true);
    assert.equal(sqlite.prepare('SELECT status FROM sync_jobs').get()?.status, 'retrying');
  } finally { await binding.close(); sqlite.close(); }
});

test('queue hosts do not install the HTTP 180 second deadline', async () => {
  const { env, sqlite } = fixture();
  const original = AbortSignal.timeout;
  const durations: number[] = [];
  AbortSignal.timeout = ms => { durations.push(ms); return new AbortController().signal; };
  try {
    await host(env, { messages: [] }).close();
    assert.deepEqual(durations, [720000]);
    await host(env).close();
    assert.deepEqual(durations, [720000, 180000]);
  } finally { AbortSignal.timeout = original; sqlite.close(); }
});
