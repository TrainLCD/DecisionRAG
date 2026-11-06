CREATE TABLE repositories (
  repo TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  docs_commit TEXT,
  issues_dispatched_at TEXT
);
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('issue','pr','feedback','doc')),
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  body TEXT NOT NULL,
  metadata TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX sources_hierarchy ON sources(repo,kind,id);
CREATE TABLE passages (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX passages_source ON passages(source_id,ordinal);
CREATE TABLE sync_jobs (
  id TEXT PRIMARY KEY,
  job TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT
);
CREATE INDEX sync_jobs_status ON sync_jobs(status,updated_at);
