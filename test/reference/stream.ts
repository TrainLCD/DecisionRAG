import { HttpError } from './types.js';

/** Decode SSE across arbitrary UTF-8 and line boundaries, with bounded buffering. */
export async function readSse(stream: ReadableStream<Uint8Array>, signal: AbortSignal,
  onData: (data: string) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '', lines: string[] = [], bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  /** Dispatch one SSE event when its terminating blank line arrives. */
  const line = (value: string) => {
    if (!value) { if (lines.length) onData(lines.join('\n')); lines = []; }
    else if (value.startsWith('data:')) lines.push(value.slice(5).replace(/^ /, ''));
  };
  try {
    signal.throwIfAborted();
    for (;;) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 2_000_000) throw new HttpError(502, 'upstream_body_too_large');
      pending += decoder.decode(part.value, { stream: true });
      let index: number;
      while ((index = pending.indexOf('\n')) >= 0) {
        line(pending.slice(0, index).replace(/\r$/, ''));
        pending = pending.slice(index + 1);
      }
    }
    pending += decoder.decode();
    if (pending) line(pending.replace(/\r$/, ''));
    line('');
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Extract text values from incomplete generated JSON without treating prose as keys. */
export function draftPreview(json: string) {
  const answer: string[] = [], summaries: string[] = [];
  let section = answer;
  for (let i = 0; i < json.length; i++) {
    if (json[i] !== '"') continue;
    const start = ++i;
    for (; i < json.length; i++) {
      if (json[i] === '\\') { i++; continue; }
      if (json[i] === '"') break;
    }
    if (i >= json.length) break;
    const key = JSON.parse('"' + json.slice(start, i) + '"') as string;
    let next = i + 1;
    while (/\s/.test(json[next] ?? '') && next < json.length) next++;
    if (json[next] !== ':') continue;
    if (key === 'claims') section = answer;
    if (key === 'summaries') section = summaries;
    if (key !== 'text') continue;
    next++;
    while (/\s/.test(json[next] ?? '') && next < json.length) next++;
    if (json[next] !== '"') continue;
    const textStart = ++next;
    let end = next;
    while (next < json.length && json[next] !== '"') {
      if (json[next] === '\\') {
        const size = json[next + 1] === 'u' ? 6 : 2;
        if (next + size > json.length) break;
        next += size;
      } else next++;
      end = next;
    }
    try { section.push(JSON.parse('"' + json.slice(textStart, end) + '"') as string); } catch { /* incomplete escape */ }
    i = next;
  }
  return { answer, summaries };
}

/** Consume provider tokens immediately while retaining the JSON for final verification. */
export async function collectGeneration(stream: ReadableStream<Uint8Array>, signal: AbortSignal,
  onDraft: (preview: ReturnType<typeof draftPreview>) => void) {
  let content = '', done = false, lastDraft = -Infinity, publishedLength = 0;
  /** Keep optional previews bounded in frequency and independent of final generation. */
  const publishDraft = (force = false) => {
    const now = Date.now();
    if (content.length === publishedLength || !force && now - lastDraft < 100) return;
    lastDraft = now;
    publishedLength = content.length;
    try { onDraft(draftPreview(content)); } catch { /* Final JSON still undergoes validation. */ }
  };
  let model: string | undefined;
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  await readSse(stream, signal, data => {
    if (data === '[DONE]') { done = true; publishDraft(true); return; }
    if (done) return;
    const chunk = JSON.parse(data);
    if (chunk.error) throw new HttpError(502, 'generation_unavailable');
    model = chunk.model ?? model;
    usage = chunk.usage ?? usage;
    const delta = chunk.choices?.[0]?.delta?.content ?? chunk.response;
    if (typeof delta === 'string') {
      content += delta;
      publishDraft();
    }
  });
  if (!done) throw new HttpError(502, 'incomplete_generation_stream');
  return { model, usage, choices: [{ message: { content } }] };
}
