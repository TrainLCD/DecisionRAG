// Compare the deployed candidate-page UI with full-result pagination on the same corpus.
// Run serially to avoid competing for model capacity. Failed requests remain in the report.
// BASELINE_URL=... CANDIDATE_URL=... node --use-env-proxy scripts/benchmark-pagination.mjs output.json
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const variants = [
  { name: 'before', url: process.env.BASELINE_URL, paginated: true },
  { name: 'after', url: process.env.CANDIDATE_URL },
];
if (variants.some(v => !v.url)) throw new Error('Set BASELINE_URL and CANDIDATE_URL');
const queries = ['地下鉄で位置更新が止まる問題', '東京メトロ固有の問題はある？', '直通情報がすぐに反映されない問題'];
const output = process.argv[2] ?? 'pagination-benchmark.json';
const report = { started_at: new Date().toISOString(), repetitions: 3, variants, runs: [] };
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');

async function measure(variant, query, mode, round) {
  const row = { variant: variant.name, query, mode, round };
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  try {
    const response = await fetch(new URL('/' + mode, variant.url), {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(mode === 'answer' ? { Accept: 'text/event-stream' } : {}) },
      body: JSON.stringify({ query, include_feedback: false, ...(variant.paginated ? { paginated: true } : {}) }),
      signal: AbortSignal.timeout(180_000),
    });
    row.http_status = response.status;
    let data;
    if (response.ok && response.headers.get('content-type')?.includes('text/event-stream')) {
      let pending = '';
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const block = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const event = block.match(/^event: (.+)$/m)?.[1];
          const value = JSON.parse(block.match(/^data: (.+)$/m)?.[1] ?? '{}');
          if (event === 'sources') row.sources_ms = elapsed();
          if (event === 'draft' && row.first_draft_ms === undefined) row.first_draft_ms = elapsed();
          if (event === 'error') throw new Error(value.error);
          if (event === 'result') data = value;
        }
      }
      if (!data) throw new Error('stream ended without result');
    } else data = await response.json();
    row.total_ms = elapsed();
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    row.server_ms = data.elapsed_ms;
    row.hit_count = data.hit_count;
    row.status = data.status;
    row.evidence_ids = data.evidence.map(p => p.id);
    row.source_ids = [...new Set(data.evidence.map(p => p.source_id))];
    row.timings = data.timings;
    row.trace = data.trace;
    row.pagination = data.pagination ? { page: data.pagination.page, total_pages: data.pagination.total_pages } : null;
    if (data.hit_count !== data.evidence.length || new Set(row.evidence_ids).size !== row.evidence_ids.length)
      throw new Error('inconsistent count or duplicate evidence');
  } catch (error) {
    row.total_ms = elapsed();
    row.error = error.message;
  }
  report.runs.push(row);
  save();
  console.log(JSON.stringify({ ...row, evidence_ids: undefined, source_ids: undefined, trace: undefined, timings: undefined }));
}

for (let round = 1; round <= report.repetitions; round++) {
  for (const query of queries) {
    for (const variant of round % 2 ? variants : [...variants].reverse()) await measure(variant, query, 'search', round);
  }
  // Representative streaming query, including actual first-draft and final-result latency.
  for (const variant of round % 2 ? variants : [...variants].reverse()) await measure(variant, queries[0], 'answer', round);
}
report.finished_at = new Date().toISOString();
save();
if (report.runs.some(row => row.error)) process.exitCode = 1;
