import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
test('correction removes false relevance without changing retrievals or the original report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-rescore-'));
  try {
    const input = join(dir, 'input.json'), questions = join(dir, 'questions.json'), output = join(dir, 'output.json');
    const row = { id: 'A2', query: 'watch', mode: 'normal', ids: ['watch', 'phone'], required_count: 1, recalled_count: 1, unrelated_at_10: 0 };
    writeFileSync(input, JSON.stringify({ questions_sha256: 'original', results: [row] }));
    writeFileSync(questions, JSON.stringify({ label_correction: 'phone is not watch', questions: [{ id: 'A2', query: 'watch', required_groups: [['watch']], relevant_ids: ['watch'] }] }));
    execFileSync(process.execPath, ['scripts/evaluation/rescore.mjs', input, questions, output]);
    const corrected = JSON.parse(readFileSync(output));
    assert.equal(corrected.results[0].unrelated_at_10, 0.5);
    assert.deepEqual(corrected.results[0].ids, row.ids);
    assert.equal(JSON.parse(readFileSync(input)).results[0].unrelated_at_10, 0);
    assert.equal(corrected.rescored_from.questions_sha256, 'original');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
