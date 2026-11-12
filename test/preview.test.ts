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
    await assert.rejects(preview.queue(), /preview_read_only/);
    await assert.rejects(preview.scheduled(), /preview_read_only/);
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

test('evaluation fingerprint includes public source changes but excludes private sources', async () => {
  const { env, sqlite } = fixture();
  const { mockFetch } = await import('./helpers.js');
  const { evaluationSnapshot } = await import('../src/evaluation.js');
  const { saveSource } = await import('../src/store.js');
  const restore = mockFetch(() => Response.json([{ full_name: 'TrainLCD/Public', private: false, visibility: 'public', archived: false }]));
  try {
    for (const repo of ['TrainLCD/Public', 'TrainLCD/Private'])
      sqlite.prepare("INSERT INTO repositories(repo,description,default_branch) VALUES(?,'','main')").run(repo);
    const source = { id: 'TrainLCD/Public#1', repo: 'TrainLCD/Public', kind: 'issue' as const, title: 'Public', url: 'https://github.com/TrainLCD/Public/issues/1', body: 'Original', metadata: {}, updated_at: '2026-11-12' };
    await saveSource(env, source);
    const before = await evaluationSnapshot(env);
    await saveSource(env, { ...source, id: 'TrainLCD/Private#1', repo: 'TrainLCD/Private', body: 'secret' });
    assert.deepEqual(await evaluationSnapshot(env), before);
    await saveSource(env, { ...source, body: 'Changed' });
    assert.notEqual((await evaluationSnapshot(env)).revision, before.revision);
    assert.deepEqual(before.source_ids, [source.id]);
  } finally { restore(); sqlite.close(); }
});
