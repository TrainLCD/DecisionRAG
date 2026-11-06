import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { Env, SyncJob } from '../src/types.js';
export function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(readFileSync(new URL('../../migrations/0001_initial.sql', import.meta.url), 'utf8'));
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
    try { const results = []; for (const s of statements) results.push(await s.run()); sqlite.exec('COMMIT'); return results; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  } } as unknown as D1Database;
  const jobs: SyncJob[] = [];
  const env: Env = { DB: db, SYNC_QUEUE: { send: async (job: SyncJob) => { jobs.push(job); } } as unknown as Queue<SyncJob>,
    API_TOKEN: 'test-private-token', WEBHOOK_SECRET: 'test-webhook-secret', GITHUB_TOKEN: 'test-github-token',
    TYPESAFE_API_KEY: 'test-jev-key', GITHUB_ORG: 'TrainLCD', JEV_MODEL: 'jev-test' };
  return { sqlite, env, jobs };
}
export function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
  return () => { globalThis.fetch = original; };
}
