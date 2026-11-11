import { HttpError } from './types.js';

export interface SearchCursor {
  query: string; scope: string; ids: string[]; offset: number; revision: string; expires: number;
}
const maxCursorLength = 200_000;
/** Derive an encryption key without exposing credentials in continuation URLs. */
async function key(secret: string) {
  if (!secret) throw new HttpError(503, 'authentication_not_configured');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('search-cursor-v1:' + secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
/** Encrypt and authenticate a short-lived search plan, including its scope. */
export async function encodeCursor(value: SearchCursor, secret: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await key(secret),
    new TextEncoder().encode(JSON.stringify(value))));
  const bytes = new Uint8Array(nonce.length + encrypted.length);
  bytes.set(nonce); bytes.set(encrypted, nonce.length);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const result = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (result.length > maxCursorLength) throw new HttpError(422, 'search_plan_too_large');
  return result;
}
/** Reject altered, expired or cross-query/scope cursors before loading passages. */
export async function decodeCursor(token: string, secret: string, query: string, scope: string): Promise<SearchCursor> {
  if (!secret) throw new HttpError(503, 'authentication_not_configured');
  try {
    if (token.length > maxCursorLength || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const bytes = Uint8Array.from(atob(token.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await key(secret), bytes.slice(12));
    const value = JSON.parse(new TextDecoder().decode(plain)) as SearchCursor;
    if (value.query !== query || value.scope !== scope || !Number.isFinite(value.expires) || value.expires <= Date.now() ||
      !Array.isArray(value.ids) || value.ids.some(id => typeof id !== 'string') ||
      !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset % 20 || typeof value.revision !== 'string') throw new Error();
    return value;
  } catch { throw new HttpError(400, 'invalid_search_cursor'); }
}
