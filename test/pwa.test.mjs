import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
function worker() {
  const handlers = {};
  const cached = new Map();
  let skipped = false;
  const cache = {
    addAll: async (paths) => paths.forEach(p => cached.set(p, new Response(p))),
    match: async (key) => cached.get(typeof key === 'string' ? key : new URL(key.url).pathname),
  };
  vm.runInNewContext(source, {
    self: { location: { origin: 'https://example.com' }, addEventListener: (name, fn) => handlers[name] = fn,
      clients: { claim: async () => {} }, skipWaiting: async () => { skipped = true; } },
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    URL, Response, fetch: async () => { throw new Error('offline'); },
  });
  return { handlers, cached, skipped: () => skipped };
}
test('offline cache contains only fallback assets; API and unrelated navigation are untouched', async () => {
  const w = worker();
  let pending;
  w.handlers.install({ waitUntil: p => pending = p });
  await pending;
  assert.deepEqual([...w.cached.keys()], ['/offline.html', '/offline.css']);
  for (const [pathname, method, mode] of [['/v1/search','POST','cors'], ['/v1/status','GET','cors'], ['/v1/status','GET','navigate'], ['/other','GET','navigate']]) {
    w.handlers.fetch({ request: { url: 'https://example.com'+pathname, method, mode }, respondWith: () => assert.fail('intercepted API or unrelated page') });
  }
  w.handlers.fetch({ request: { url:'https://example.com/', method:'GET', mode:'navigate' }, respondWith: p => pending = p });
  assert.equal(await (await pending).text(), '/offline.html');
  assert.equal(w.skipped(), false);
});
test('waiting worker activates only on explicit update message', async () => {
  const w = worker();
  let pending;
  w.handlers.message({ data: { type:'OTHER' }, waitUntil: p => pending=p });
  assert.equal(w.skipped(), false);
  w.handlers.message({ data: { type:'SKIP_WAITING' }, waitUntil: p => pending=p });
  await pending;
  assert.equal(w.skipped(), true);
});
