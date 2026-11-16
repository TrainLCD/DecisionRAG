import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('quality gate rejects missing repeats and errors, without reporting errors as zero hits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-summary-'));
  const ids = Array.from({length: 20}, (_, i) => `Q${i}`);
  const report = {model_mode: 'real', split: 'evaluation', expected_question_ids: ids, results: []};
  for (const id of ids) for (const engine of ['jev', 'rust-rules-v1']) for (const run of [1, 2, 3]) {
    report.results.push({id, engine, run, group: 'A', mode: 'normal', status: 200,
      required_count: 1, recalled_count: 1, hits: 1, unrelated_at_10: 0,
      mandatory: true, missing: [], leaked: false, empty_with_evidence: false,
      elapsed_ms: 1, model_calls: 0, input_tokens: 0, output_tokens: 0});
  }
  const score = () => {
    const input = join(dir, 'input.json'), output = join(dir, 'output.json');
    writeFileSync(input, JSON.stringify(report));
    execFileSync(process.execPath, ['scripts/evaluation/summarize.mjs', input, output]);
    return JSON.parse(readFileSync(output));
  };
  try {
    assert.equal(score().pass, true);
    const row = report.results[0];
    row.run = 2;
    assert.equal(score().gates.complete, false, 'duplicate repeats do not replace missing runs');
    row.run = 1;
    Object.assign(row, {status: 502, hits: null, recalled_count: 0, empty_with_evidence: true,
      input_tokens: null, output_tokens: null, observed_input_tokens: 123, observed_output_tokens: 7});
    const failed = score();
    assert.equal(failed.pass, false);
    assert.equal(failed.gates.normal_requests_succeed, false);
    assert.equal(failed.jev.false_zero, 0);
    assert.equal(failed.jev.input_tokens, null);
    assert.equal(failed.jev.observed_input_tokens, 123);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
