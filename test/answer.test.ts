import test from 'node:test';
import assert from 'node:assert/strict';
import { answer } from '../src/answer.js';
import type { CitedClaim, Judge } from '../src/jev.js';
import type { Evidence } from '../src/retrieval.js';
import type { Env } from '../src/types.js';

const evidence: Evidence[] = ['a', 'a', 'b'].map((source_id, i) => ({
  id: String(i), source_id, ordinal: i, text: 'Reported issue', title: source_id,
  repo: 'TrainLCD/Issues', kind: 'feedback', metadata: {}, updated_at: '',
  url: 'https://github.com/TrainLCD/Issues/issues/' + i, citation: 'p' + (i + 1), relevance: 0.9,
}));

test('separates the direct answer from verified summaries and rejects mismatched sources', async () => {
  let supportAnswer = true;
  const judge = {
    trace: [],
    async verify(_query: string, _evidence: unknown, claims: CitedClaim[]) {
      assert.deepEqual(claims.map(c => c.text), ['Reports exist.', 'First ticket.', 'Unsupported ticket.']);
      return { claims: [supportAnswer ? 1 : 0, 1, 0], complete: 1, conflict: 0 };
    },
  } as unknown as Judge;
  const env = { AI: { async run() {
    return { choices: [{ message: { content: JSON.stringify({
      claims: [{ text: 'Reports exist.', citations: ['p1', 'p3'] }],
      summaries: [
        { source_id: 'a', text: 'First ticket.', citations: ['p1', 'p2'] },
        { source_id: 'a', text: 'Duplicate.', citations: ['p2'] },
        { source_id: 'b', text: 'Wrong source.', citations: ['p1'] },
        { source_id: 'missing', text: 'Unknown.', citations: ['p99'] },
        { source_id: 'b', text: 'Unsupported ticket.', citations: ['p3'] },
      ],
    }) } }] };
  } } } as unknown as Env;
  const result = await answer('Any reports?', evidence, env, judge);
  assert.equal(result.status, 'answered');
  assert.equal(result.answer, 'Reports exist. [p1] [p3]');
  assert.deepEqual(result.ticket_summaries, [{ source_id: 'a', text: 'First ticket.', citations: ['p1', 'p2'] }]);
  supportAnswer = false;
  const partial = await answer('Any reports?', evidence, env, judge);
  assert.equal(partial.status, 'summarized');
  assert.equal(partial.answer, null);
  assert.equal(partial.ticket_summaries?.length, 1);
  assert.deepEqual(partial.citations, ['p1', 'p2']);
});
