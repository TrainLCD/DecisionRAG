import test from 'node:test';
import assert from 'node:assert/strict';
import { Jev } from './legacy-judge.js';
import type { Env } from '../src/types.js';

test('Clef screens every candidate within the 64-question limit without Typesafe credentials', async () => {
  const sizes: number[] = [];
  const env = { AI: { async run(model: string, input: { model: string; questions: Record<string, unknown> }, options: { signal: AbortSignal }) {
    assert.equal(model, `@cf/cloudflare/${expectedModel}`);
    assert.equal(input.model, expectedModel);
    assert.ok(options.signal instanceof AbortSignal);
    const ids = Object.keys(input.questions);
    assert.ok(ids.length <= 64);
    sizes.push(ids.length);
    return { model: expectedModel, answers: Object.fromEntries(ids.map(id => [id, { type: 'noul', noul: 0.9 }])),
      usage: { input_tokens: 10, output_tokens: 0 } };
  } } } as unknown as Env;
  let expectedModel = 'clef-flash';
  for (const stage of ['document_screening', 'branch_screening', 'passage_scoring']) {
    expectedModel = stage === 'passage_scoring' ? 'clef' : 'clef-flash';
    sizes.length = 0;
    const candidates = Array.from({ length: 130 }, (_, i) => ({ id: String(i), description: String(i) }));
    const judge = new Jev(env);
    assert.deepEqual((await judge.score('query', candidates, stage)).map(row => row.item.id), candidates.map(row => row.id));
    assert.deepEqual(sizes, stage === 'passage_scoring' ? [60, 60, 10] : [64, 64, 2]);
    assert.deepEqual(judge.trace[0]?.model, [expectedModel]);
  }
});

test('Clef errors are sanitized and a missing binding fails explicitly', async () => {
  const items = [{ id: 'x', description: 'x' }];
  await assert.rejects(new Jev({} as Env).score('q', items, 'document_screening'), /decision_not_configured/);
  const env = { AI: { async run() { throw new Error('private upstream body'); } } } as unknown as Env;
  await assert.rejects(new Jev(env).score('q', items, 'document_screening'), /decision_upstream_error/);
});

test('screening bounds include Unicode query, instructions and every full candidate', async () => {
  const seen: string[] = [];
  const models: string[] = [];
  const env = { AI: { async run(model: string, input: { state: { candidates: Record<string, string> }; questions: Record<string, unknown> }) {
    const bytes = new TextEncoder().encode(JSON.stringify({ state: input.state, questions: input.questions })).byteLength;
    assert.ok(bytes + 4096 <= (model.endsWith('clef-flash') ? 24576 : 65536));
    models.push(model);
    seen.push(...Object.values(input.state.candidates));
    return { model, answers: Object.fromEntries(Object.keys(input.questions).map(id => [id, { type: 'noul', noul: 0.9 }])),
      usage: { input_tokens: 1, output_tokens: 0 } };
  } } } as unknown as Env;
  const candidates = Array.from({ length: 64 }, (_, i) => ({ id: String(i), description: `${i}:` + '地下鉄🚃'.repeat(100) }));
  for (const stage of ['document_screening', 'branch_screening']) {
    seen.length = models.length = 0;
    const rows = await new Jev(env).score('検索'.repeat(750), candidates, stage);
    assert.deepEqual(rows.map(row => row.item.id), candidates.map(row => row.id));
    assert.deepEqual(seen, candidates.map(row => row.description));
    assert.ok(models.length > 1);
    assert.ok(models.every(model => model.endsWith('clef-flash')));
  }
  seen.length = models.length = 0;
  await new Jev(env).score('query', [{ id: 'large', description: 'あ'.repeat(8000) }], 'document_screening');
  assert.deepEqual(models, ['@cf/cloudflare/clef']);
  assert.equal(seen[0], 'あ'.repeat(8000));
  seen.length = models.length = 0;
  await assert.rejects(new Jev(env).score('query', [{ id: 'oversize', description: 'あ'.repeat(24000) }], 'document_screening'), /candidate_too_large/);
  assert.equal(models.length, 0);
});

test('document screening uses Clef for documentation without upgrading neighboring issues', async () => {
  const seen: Array<{ model: string; descriptions: string[] }> = [];
  const env = { AI: { async run(model: string, input: { state: { candidates: Record<string, string> }; questions: Record<string, unknown> }) {
    seen.push({ model, descriptions: Object.values(input.state.candidates) });
    return { model, answers: Object.fromEntries(Object.keys(input.questions).map(id => [id, { type: 'noul', noul: 0.9 }])),
      usage: { input_tokens: 1, output_tokens: 0 } };
  } } } as unknown as Env;
  const candidates = [{ id: 'issue', kind: 'issue' as const, description: 'issue body' },
    { id: 'doc', kind: 'doc' as const, description: 'long document body' },
    { id: 'pr', kind: 'pr' as const, description: 'fix body' }];
  await new Jev(env).score('query', candidates, 'document_screening');
  assert.deepEqual(seen, [
    { model: '@cf/cloudflare/clef-flash', descriptions: ['issue body'] },
    { model: '@cf/cloudflare/clef', descriptions: ['long document body'] },
    { model: '@cf/cloudflare/clef-flash', descriptions: ['fix body'] },
  ]);
});


test('provider capacity and rate failures expose only fixed recoverable categories', async () => {
  for (const [message, status, code] of [
    ['3040: Capacity temporarily exceeded private data', 503, 'decision_capacity_exceeded'],
    ['429: Rate limit exceeded private data', 429, 'decision_rate_limited'],
    ['3036: Account limited private data', 503, 'decision_quota_exceeded'],
  ] as const) {
    const env = { AI: { async run() { throw new Error(message); } } } as unknown as Env;
    await assert.rejects(new Jev(env).score('q', [{ id: 'x', description: 'x' }], 'document_screening'),
      (error: any) => error.status === status && error.code === code && !error.message.includes('private'));
  }
});
