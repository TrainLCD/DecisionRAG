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

test('a deadline reached while reading the response body is reported as a timeout', async (t) => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
  const fetchWithStalledBody: typeof globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
    pull(stream) {
      deadline.abort(new DOMException('Deadline exceeded', 'TimeoutError'));
      assert.ok(init?.signal?.aborted);
      stream.error(new DOMException('Response body aborted', 'AbortError'));
    },
  }, { highWaterMark: 0 }));
  t.mock.method(globalThis, 'fetch', fetchWithStalledBody);
  await assert.rejects(jsonRequest('https://api.github.com/test'), { status: 502, code: 'upstream_timeout' });
});
