ALTER TABLE sources ADD COLUMN vocabulary_revision TEXT NOT NULL DEFAULT '';
CREATE TABLE vocabulary_runs (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  next_ordinal INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE vocabulary_entries (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  term TEXT NOT NULL,
  alias TEXT NOT NULL,
  quote TEXT NOT NULL,
  relation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(source_id, revision, ordinal, term, alias)
);
CREATE INDEX vocabulary_terms ON vocabulary_entries(term, alias);
CREATE TABLE vocabulary_blocks (
  term TEXT NOT NULL,
  alias TEXT NOT NULL,
  reason TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(term, alias)
);
CREATE TABLE vocabulary_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL,
  alias TEXT NOT NULL,
  blocked INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- Invalidate immediately, including writes by a pre-migration Worker.
CREATE TRIGGER vocabulary_source_changed AFTER UPDATE OF body,title ON sources
WHEN OLD.body<>NEW.body OR OLD.title<>NEW.title
BEGIN
  DELETE FROM vocabulary_entries WHERE source_id=NEW.id;
  DELETE FROM vocabulary_runs WHERE source_id=NEW.id;
  UPDATE sources SET vocabulary_revision='' WHERE id=NEW.id;
END;
