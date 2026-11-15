// Read-only smoke comparison against a running index. Not a frozen-corpus
// precision benchmark: synchronization and model decisions can change results.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [baseline, preview, output] = process.argv.slice(2);
if (!baseline || !preview || !output) throw Error('Usage: node scripts/benchmark-jev-preview.mjs BASELINE_URL PREVIEW_URL OUTPUT.json');
for (const url of [baseline, preview]) if (new URL(url).protocol !== 'https:') throw Error('HTTPS required');
const questions = [
  'バス対応の網羅率',
  'バス対応',
  'どこまでバスに対応していますか？',
  'Apple Watchではバスからの乗換をどう案内しますか？',
];
const report = { recorded_at: new Date().toISOString(), scope: 'Live public index, no generation. Three independent runs per question and engine. Smoke only; not the 40-question frozen evaluation or aggregate verification.', baseline, preview, results: [] };
for (const query of questions) for (let run = 1; run <= 3; run++) for (const [label, url] of [['baseline', baseline], ['preview', preview]]) {
  const start = Date.now();
  const response = spawnSync('curl', ['--silent', '--show-error', '--max-time', '150', '--header', 'Content-Type: application/json', '--data-binary', JSON.stringify({ query }), '--write-out', '\n%{http_code}', url.replace(/\/$/, '') + '/search'], { encoding: 'utf8', maxBuffer: 20_000_000 });
  const raw = response.stdout ?? '';
  const split = raw.lastIndexOf('\n');
  const status = Number(raw.slice(split + 1));
  let data;
  try { data = JSON.parse(raw.slice(0, split)); } catch { data = { error: 'non_json_response' }; }
  const traces = data.trace ?? [];
  const row = { query, run, label, status, transport_status: response.status, wall_ms: Date.now() - start, elapsed_ms: data.elapsed_ms, error: data.error, engine: data.retrieval, hits: data.hit_count, calls: traces.reduce((n,t) => n + (t.calls ?? 0), 0), input_tokens: traces.reduce((n,t) => n + (t.input_tokens ?? 0), 0), output_tokens: traces.reduce((n,t) => n + (t.output_tokens ?? 0), 0), evidence: (data.evidence ?? []).map(p => ({ id: p.id, source_id: p.source_id, relevance: p.relevance })) };
  report.results.push(row);
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...row, evidence: undefined }));
  if (response.status || status !== 200) process.exitCode = 1;
}
