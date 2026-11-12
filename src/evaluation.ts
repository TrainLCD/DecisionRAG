import { GitHub } from './github.js';
import type { Env } from './types.js';

/** Fingerprint public search inputs without returning their bodies or private records. */
export async function evaluationSnapshot(env: Env) {
  const repos = JSON.stringify((await new GitHub(env).publicRepositories()).sort());
  const scoped = `s.kind<>'feedback' AND lower(s.repo) IN (SELECT value FROM json_each(?))
    AND (s.kind<>'pr' OR instr(s.body,char(10)||'PENDING'||char(10))=0)`;
  const results = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(`SELECT s.* FROM sources s JOIN repositories r ON r.repo=s.repo WHERE ${scoped} ORDER BY s.id`).bind(repos),
    env.DB.prepare(`SELECT p.* FROM passages p JOIN sources s ON s.id=p.source_id JOIN repositories r ON r.repo=s.repo WHERE ${scoped} ORDER BY p.id`).bind(repos),
    env.DB.prepare('SELECT * FROM repositories WHERE lower(repo) IN (SELECT value FROM json_each(?)) ORDER BY repo').bind(repos),
    env.DB.prepare('SELECT * FROM github_releases WHERE lower(repo) IN (SELECT value FROM json_each(?)) ORDER BY repo,tag').bind(repos),
    env.DB.prepare('SELECT * FROM github_release_commits WHERE lower(repo) IN (SELECT value FROM json_each(?)) ORDER BY repo,sha').bind(repos),
  ]);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([repos, ...results.map(r => r.results)])));
  return { revision: Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join(''),
    source_ids: results[0]!.results.map(r => r.id), sources: results[0]!.results.length, passages: results[1]!.results.length };
}
