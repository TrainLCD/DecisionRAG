CREATE TABLE github_releases (
  repo TEXT PRIMARY KEY REFERENCES repositories(repo) ON DELETE CASCADE,
  tag TEXT,
  commit_sha TEXT,
  published_at TEXT,
  url TEXT,
  checked_at TEXT NOT NULL,
  snapshot_id TEXT NOT NULL
);

CREATE TABLE github_release_commits (
  repo TEXT NOT NULL REFERENCES github_releases(repo) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  PRIMARY KEY (repo, sha)
);
