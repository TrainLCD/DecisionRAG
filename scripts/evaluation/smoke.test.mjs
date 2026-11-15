import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('live smoke rejects duplicate IDs within the first or later page and across pages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-smoke-'));
  const required = ['TrainLCD/StationAPI:docs/architecture.md:3', 'TrainLCD/StationAPI:docs/gtfs-bus-integration-research.md:0'];
  const run = pages => {
    writeFileSync(join(dir, 'curl'), `#!${process.execPath}\nconst args=process.argv.slice(2);const request=JSON.parse(args[args.indexOf('--data-binary')+1]);const pages=${JSON.stringify(pages)};process.stdout.write(JSON.stringify(pages[request.cursor ? 1 : 0])+'\\n200');\n`, {mode: 0o755});
    const output = join(dir, 'result.json');
    const result = spawnSync(process.execPath, ['scripts/evaluation/smoke.mjs', 'https://example.test', output], {env: {...process.env, PATH: dir + ':' + process.env.PATH}, encoding: 'utf8'});
    return {status: result.status, report: JSON.parse(readFileSync(output))};
  };
  const page = (ids, count, next) => ({evidence: ids.map(id => ({id})), hit_count: count, trace: [], retrieval_details: {cached: true}, pagination: {next_cursor: next}});
  try {
    assert.equal(run([page(required, 2)]).status, 0);
    assert.equal(run([page([required[0]], 2, 'next'), page([required[1]], 2)]).status, 0);
    for (const pages of [
      [page([required[0], ...required], 3)],
      [page([required[0]], 3, 'next'), page([required[1], required[1]], 3)],
      [page(required, 3, 'next'), page([required[1]], 3)],
    ]) {
      const result = run(pages);
      assert.equal(result.status, 1);
      assert.ok(result.report.results.every(row => /Duplicate evidence/.test(row.error)));
    }
  } finally {rmSync(dir, {recursive: true, force: true});}
});
