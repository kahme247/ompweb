// Durable entry identities and per-session revisions are shared by every connection to the outbox.
export const OUTBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  source_session_id TEXT,
  mode TEXT NOT NULL,
  message TEXT NOT NULL,
  images TEXT,
  uploads TEXT,
  upload_receipts TEXT,
  owner TEXT NOT NULL,
  advisor INTEGER NOT NULL,
  state TEXT NOT NULL,
  error TEXT,
  may_have_been_sent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  dispatch_pid INTEGER,
  payload_bytes INTEGER NOT NULL DEFAULT 0,
  previous_entry_ids TEXT,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS entries_session ON entries (session_id, state);
CREATE TABLE IF NOT EXISTS completed_uploads (id TEXT PRIMARY KEY, owner TEXT NOT NULL, receipt TEXT NOT NULL, at INTEGER NOT NULL);
`;

// Install after legacy columns are migrated. Triggers also cover writes from older peer binaries.
export const OUTBOX_CHANGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS entry_aliases (
  entry_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (entry_id, session_id)
);
CREATE INDEX IF NOT EXISTS entry_aliases_session ON entry_aliases (session_id, entry_id);
CREATE TABLE IF NOT EXISTS session_changes (
  session_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS outbox_insert_change AFTER INSERT ON entries BEGIN
  INSERT INTO session_changes (session_id, revision)
    SELECT session_id, 1 FROM (
      SELECT NEW.session_id AS session_id UNION SELECT NEW.source_session_id
    ) WHERE session_id IS NOT NULL
    ON CONFLICT (session_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS outbox_update_change AFTER UPDATE ON entries BEGIN
  INSERT OR IGNORE INTO entry_aliases (entry_id, session_id)
    SELECT OLD.id, OLD.session_id WHERE OLD.session_id != NEW.session_id;
  INSERT INTO session_changes (session_id, revision)
    SELECT session_id, 1 FROM (
      SELECT OLD.session_id AS session_id UNION SELECT NEW.session_id
      UNION SELECT OLD.source_session_id UNION SELECT NEW.source_session_id
      UNION SELECT session_id FROM entry_aliases WHERE entry_id = NEW.id
    ) WHERE session_id IS NOT NULL
    ON CONFLICT (session_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS outbox_delete_change AFTER DELETE ON entries BEGIN
  INSERT INTO session_changes (session_id, revision)
    SELECT session_id, 1 FROM (
      SELECT OLD.session_id AS session_id UNION SELECT OLD.source_session_id
      UNION SELECT session_id FROM entry_aliases WHERE entry_id = OLD.id
    ) WHERE session_id IS NOT NULL
    ON CONFLICT (session_id) DO UPDATE SET revision = revision + 1;
  DELETE FROM entry_aliases WHERE entry_id = OLD.id;
END;
`;
