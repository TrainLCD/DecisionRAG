import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { previewConfig } from '../scripts/prepare-preview.mjs';

test('preview shares DB and preserves deployed variables without sync bindings', () => {
  const original = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const id = '12345678-1234-1234-1234-123456789abc';
  const config = previewConfig(original, id);
  assert.equal(config.name, original.name);
  assert.equal(config.main, 'src/preview.ts');
  assert.equal(config.d1_databases[0].database_id, id);
  assert.deepEqual(config.ai, original.ai);
  assert.deepEqual(config.assets, original.assets);
  assert.equal(config.keep_vars, true);
  assert.equal(config.preview_urls, true);
  for (const key of ['vars', 'queues', 'triggers', 'routes', 'route']) assert.equal(key in config, false);
  assert.equal(original.main, 'src/index.ts');
  for (const bad of ['', undefined, '00000000-0000-0000-0000-000000000000', 'invalid']) {
    assert.throws(() => previewConfig(original, bad));
  }
});
