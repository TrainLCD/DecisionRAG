// Re-score saved retrievals after a documented annotation correction; no model calls.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [input, questionsFile, output] = process.argv.slice(2);
if (!input || !questionsFile || !output || input === output) throw Error('Usage: rescore.mjs INPUT QUESTIONS NEW_OUTPUT');
const report = JSON.parse(readFileSync(input, 'utf8'));
const bytes = readFileSync(questionsFile);
const annotations = JSON.parse(bytes);
if (!annotations.label_correction) throw Error('A documented label correction is required');
const questions = new Map(annotations.questions.map(q => [q.id, q]));
for (const row of report.results) {
  if (row.mode !== 'normal') continue;
  const q = questions.get(row.id);
  if (!q || q.query !== row.query || !Array.isArray(row.ids)) throw Error('Cannot rescore missing or mismatched retrieval records');
  if (q.required_groups.length !== row.required_count || q.required_groups.filter(g => g.some(id => row.ids.includes(id))).length !== row.recalled_count) throw Error('This correction may not change required facts');
  const top = row.ids.slice(0, 10);
  row.unrelated_ids = top.filter(id => !q.relevant_ids.includes(id));
  row.unrelated_at_10 = top.length ? row.unrelated_ids.length / top.length : 0;
}
report.rescored_from = { file: input, questions_sha256: report.questions_sha256 };
report.label_correction = annotations.label_correction;
report.questions_sha256 = createHash('sha256').update(bytes).digest('hex');
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
