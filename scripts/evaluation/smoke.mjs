// Read-only live regression and cursor checks. This is not a precision benchmark.
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const [preview, output] = process.argv.slice(2);
if (!preview || !output || new URL(preview).protocol !== 'https:') throw Error('Usage: smoke.mjs HTTPS_PREVIEW OUTPUT');
const report = {recorded_at: new Date().toISOString(), preview, scope: 'Live public index; two queries, all cursor pages; no generated-answer or aggregate validation', results: []};
for (const query of ['バス対応の網羅率', 'バス対応の網羅率はどれくらい？']) {
  const row = {query, pages: [], ids: [], required_recovered: false};
  report.results.push(row);
  try {
    let cursor;
    do {
      const start = Date.now();
      const response = spawnSync('curl', ['--silent', '--show-error', '--max-time', '150', '--header', 'Content-Type: application/json', '--data-binary', JSON.stringify({query, paginated: true, ...(cursor ? {cursor} : {})}), '--write-out', '\n%{http_code}', preview.replace(/\/$/, '') + '/search'], {encoding: 'utf8', maxBuffer: 20000000});
      const raw = response.stdout ?? '', split = raw.lastIndexOf('\n');
      const status = Number(raw.slice(split + 1));
      const data = JSON.parse(raw.slice(0, split));
      const ids = (data.evidence ?? []).map(p => p.id);
      const page = {status, transport_status: response.status, wall_ms: Date.now()-start, elapsed_ms: data.elapsed_ms ?? null, hits: data.hit_count ?? null, ids, cached: data.retrieval_details?.cached ?? false, calls: (data.trace ?? []).reduce((n,t)=>n+(t.calls??0),0), input_tokens: (data.trace ?? []).reduce((n,t)=>n+(t.input_tokens??0),0), output_tokens: (data.trace ?? []).reduce((n,t)=>n+(t.output_tokens??0),0)};
      row.pages.push(page);
      if (response.status || status !== 200) throw Error(`Search failed with status ${status}`);
      if (cursor && (!page.cached || page.calls !== 0 || data.trace?.length !== 0 || page.hits !== row.pages[0].hits)) throw Error('Cursor did not preserve results without inference');
      if (ids.some(id => row.ids.includes(id))) throw Error('Duplicate evidence across pages');
      row.ids.push(...ids);
      cursor = data.pagination?.next_cursor;
    } while (cursor);
    row.required_recovered = ['TrainLCD/StationAPI:docs/architecture.md:3', 'TrainLCD/StationAPI:docs/gtfs-bus-integration-research.md:0'].every(id=>row.ids.includes(id));
    if (!row.required_recovered || row.ids.length !== row.pages[0].hits) throw Error('Missing required evidence or inconsistent hit count');
    console.log(JSON.stringify({query, hits: row.ids.length, required_recovered: true, pages: row.pages.length, elapsed_ms: row.pages[0].elapsed_ms}));
  } catch (error) { row.error = error.message; process.exitCode = 1; }
  finally { writeFileSync(output, JSON.stringify(report, null, 2)+'\n'); }
}
