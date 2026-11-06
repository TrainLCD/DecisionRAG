export interface Env {
  DB: D1Database;
  SYNC_QUEUE: Queue<SyncJob>;
  API_TOKEN: string;
  WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
  TYPESAFE_API_KEY: string;
  GITHUB_ORG: string;
  JEV_MODEL: string;
  ANSWER_API_KEY?: string;
  ANSWER_MODEL?: string;
  ANSWER_BASE_URL?: string;
  SUPPORT_THRESHOLD?: string;
  CONFLICT_THRESHOLD?: string;
  MAX_SCREENED_DOCUMENTS?: string;
}
export type Kind = 'issue' | 'pr' | 'feedback' | 'doc';
export interface Source {
  id: string; repo: string; kind: Kind; title: string; url: string;
  body: string; metadata: Record<string, unknown>; updated_at: string;
}
export interface Passage {
  id: string; source_id: string; ordinal: number; text: string;
  title: string; url: string; repo: string; kind: Kind;
  metadata: Record<string, unknown>; updated_at: string;
}
export interface Candidate { id: string; description: string }
export interface Scored<T> { item: T; probability: number }
export interface Trace {
  stage: string; candidates: number; selected: string[];
  calls: number; model: string[]; input_tokens: number; output_tokens: number;
  elapsed_ms: number;
}
export type SyncJob =
  | { type: 'org'; page: number }
  | { type: 'repo'; repo: string }
  | { type: 'issues'; repo: string; page: number; since?: string; started: string }
  | { type: 'issue'; repo: string; number: number }
  | { type: 'docs'; repo: string }
  | { type: 'doc'; repo: string; path: string; sha: string; commit: string };
export interface RepoRow { repo: string; description: string; default_branch: string; docs_commit: string | null }
export class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export function boundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(503, 'invalid_configuration');
  return n;
}
