import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonRequest } from '../src/http.js';

test('upstream redirects are rejected without following them', async (t) => {
  const redirectingFetch: typeof globalThis.fetch = async (_url, init) => {
    assert.equal(init?.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://other.example/' } });
  };
  const fetch = t.mock.method(globalThis, 'fetch', redirectingFetch);
  await assert.rejects(jsonRequest('https://api.github.com/test'), { code: 'upstream_http_302' });
  assert.equal(fetch.mock.callCount(), 1);
});
