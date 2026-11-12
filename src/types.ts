export interface Env {
  AI?: Ai;
  PUBLIC_SEARCH_RATE_LIMIT?: RateLimit;
  DB: D1Database;
  SYNC_QUEUE: Queue<SyncJob>;
  API_TOKEN: string;
  WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
  GITHUB_ORG: string;
  ANSWER_API_KEY?: string;
  ANSWER_MODEL?: string;
  ANSWER_BASE_URL?: string;
  SUPPORT_THRESHOLD?: string;
  CONFLICT_THRESHOLD?: string;
  MAX_SCREENED_DOCUMENTS?: string;
}
export type SyncJob =
  | { type: 'vocabulary'; repo: string; source_id: string }
  | { type: 'vocabulary_scan'; repo: string; after?: string }
  | { type: 'org'; page: number }
  | { type: 'repo'; repo: string }
  | { type: 'issues'; repo: string; page: number; since?: string; started: string }
  | { type: 'issue'; repo: string; number: number }
  | { type: 'releases'; repo: string }
  | { type: 'docs'; repo: string }
  | { type: 'doc'; repo: string; path: string; sha: string; commit: string };
