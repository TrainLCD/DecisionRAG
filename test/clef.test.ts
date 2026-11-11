import test from 'node:test';
import assert from 'node:assert/strict';
import { Jev } from '../src/jev.js';
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
