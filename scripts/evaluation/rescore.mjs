// Re-score saved retrievals after a documented annotation correction; no model calls.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const [input, originalQuestionsFile, questionsFile, output] = process.argv.slice(2);
if (!input || !originalQuestionsFile || !questionsFile || !output) throw Error('Usage: rescore.mjs INPUT ORIGINAL_QUESTIONS CORRECTED_QUESTIONS NEW_OUTPUT');
const inputStat = statSync(input);
let outputStat;
try { outputStat = statSync(output); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (resolve(input) === resolve(output) || outputStat && inputStat.dev === outputStat.dev && inputStat.ino === outputStat.ino) throw Error('Input and output must be different files');
const report = JSON.parse(readFileSync(input, 'utf8'));
const originalBytes = readFileSync(originalQuestionsFile);
if (createHash('sha256').update(originalBytes).digest('hex') !== report.questions_sha256) throw Error('Original annotations do not match the recorded hash');
const originals = new Map(JSON.parse(originalBytes).questions.map(q => [q.id, q]));
const bytes = readFileSync(questionsFile);
const annotations = JSON.parse(bytes);
if (!annotations.label_correction) throw Error('A documented label correction is required');
const questions = new Map(annotations.questions.map(q => [q.id, q]));
if (questions.size !== originals.size) throw Error('Question set cannot change during annotation correction');
for (const [id, q] of questions) {
  const original = originals.get(id);
  if (!original || ['query', 'mode', 'mandatory', 'required_groups'].some(key => JSON.stringify(q[key]) !== JSON.stringify(original[key]))) throw Error('Required facts and question contracts cannot change during annotation correction');
  if (q.required_groups.some(g => !g.some(id => q.relevant_ids.includes(id)))) throw Error('Each required group needs at least one relevant id');
  if (q.relevant_ids.some(id => !original.relevant_ids.includes(id))) throw Error('This correction only removes false relevance');
}
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
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
