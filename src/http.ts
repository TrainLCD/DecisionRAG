import { HttpError } from './types.js';
export async function readText(response: Response, maxBytes = 2_000_000): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new HttpError(413, 'upstream_body_too_large');
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}
export interface TaggedJson<T> { value: T; etag: string | null }

/** Fetch upstream JSON with an optional ETag. Reuse the body only on HTTP 304. */
export async function taggedJsonRequest<T>(url: string, init: RequestInit = {}, maxBytes?: number,
  previous?: TaggedJson<T>): Promise<TaggedJson<T>> {
  const signal = AbortSignal.timeout(25_000);
  const headers = new Headers(init.headers);
  if (previous?.etag) headers.set('If-None-Match', previous.etag);
  let response: Response;
  try {
    // Workers supports manual redirects. Reject 3xx below before credentials can be forwarded.
    response = await fetch(url, { ...init, headers, signal, redirect: 'manual' });
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) throw new HttpError(502, 'upstream_timeout');
    throw new HttpError(502, 'upstream_network_error');
  }
  if (response.status === 304 && previous?.etag) return previous;
  if (!response.ok) {
    await response.body?.cancel();
    // Never echo upstream bodies, headers, credentials or retrieved private text.
    throw new HttpError(502, `upstream_http_${response.status}`);
  }
  try { return { value: JSON.parse(await readText(response, maxBytes)) as T, etag: response.headers.get('ETag') }; }
  catch (error) {
    if (error instanceof HttpError) throw error;
    if (signal.aborted) throw new HttpError(502, 'upstream_timeout');
    throw new HttpError(502, 'invalid_upstream_json');
  }
}

/** Fetch and parse upstream JSON under a deadline that also covers reading the body. */
export async function jsonRequest<T>(url: string, init: RequestInit = {}, maxBytes?: number): Promise<T> {
  return (await taggedJsonRequest<T>(url, init, maxBytes)).value;
}
export async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  }));
  return results;
}
