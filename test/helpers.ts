import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import type { Env, SyncJob } from '../src/types.js';
import { HttpError } from '../src/types.js';
let mockUpstream: ((url: string, init?: RequestInit) => Response | Promise<Response>) | undefined;
export function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  const migrations = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort())
    sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  class Statement {
    values: (string | number | null)[] = [];
    constructor(readonly sql: string) {}
    bind(...values: (string | number | null)[]) { this.values = values; return this; }
    async run() { const result = sqlite.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; }
    async all() { return { success: true, results: sqlite.prepare(this.sql).all(...this.values), meta: {} }; }
    async first(column?: string) { const row = sqlite.prepare(this.sql).get(...this.values); return column ? row?.[column] ?? null : row ?? null; }
  }
  const db = { prepare: (sql: string) => new Statement(sql), async batch(statements: Statement[]) {
    sqlite.exec('BEGIN');
    try { const results = []; for (const s of statements) results.push(await s.all()); sqlite.exec('COMMIT'); return results; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  } } as unknown as D1Database;
  const jobs: SyncJob[] = [];
  const env: Env = { DB: db, SYNC_QUEUE: { send: async (job: SyncJob) => { jobs.push(job); } } as unknown as Queue<SyncJob>,
    API_TOKEN: 'test-private-token', WEBHOOK_SECRET: 'test-webhook-secret', GITHUB_TOKEN: 'test-github-token',
    GITHUB_ORG: 'TrainLCD', AI: { async run(model: string, input: Record<string, unknown>) {
      if (model !== '@cf/cloudflare/clef-flash' && model !== '@cf/cloudflare/clef') throw new Error('Generation is not configured in this fixture');
      if (!mockUpstream) throw new Error('Missing decision mock');
      const response = await mockUpstream('https://workers-ai.test/decision', { body: JSON.stringify(input) });
      const data = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new HttpError(502, JSON.stringify(data).includes('max_tokens_exceeded')
        ? 'upstream_context_limit' : `upstream_http_${response.status}`);
      return data;
    } } as unknown as Ai };
  return { sqlite, env, jobs };
}
export function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  const previous = mockUpstream;
  mockUpstream = handler;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
  return () => { globalThis.fetch = original; mockUpstream = previous; };
}

