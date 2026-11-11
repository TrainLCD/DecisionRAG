import assert from 'node:assert/strict';
import test from 'node:test';
import preview from '../src/preview.js';
import { fixture } from './helpers.js';

const ctx = {} as ExecutionContext;
test('preview rejects mutations even with valid admin credentials', async () => {
  const { env, jobs, sqlite } = fixture();
  try {
    for (const path of ['/sync', '/admin/purge', '/webhooks/github', '/future-write']) {
      const response = await preview.fetch(new Request(`https://preview.example${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${env.API_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ repo: 'TrainLCD/MobileApp' }),
      }), env, ctx);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: 'preview_read_only' });
    }
    assert.equal(jobs.length, 0);
    assert.equal('queue' in preview, false);
    assert.equal('scheduled' in preview, false);
  } finally { sqlite.close(); }
});

test('preview preserves health, search validation and private status authentication', async () => {
  const { env, sqlite } = fixture();
  try {
    assert.equal((await preview.fetch(new Request('https://preview.example/health'), env, ctx)).status, 200);
    assert.equal((await preview.fetch(new Request('https://preview.example/sync/status'), env, ctx)).status, 401);
    assert.equal((await preview.fetch(new Request('https://preview.example/sync/status', {
      headers: { authorization: `Bearer ${env.API_TOKEN}` },
    }), env, ctx)).status, 200);
    for (const path of ['/search', '/answer']) {
      const response = await preview.fetch(new Request(`https://preview.example${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      }), env, ctx);
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('X-Robots-Tag'), 'noindex');
    }
  } finally { sqlite.close(); }
});
