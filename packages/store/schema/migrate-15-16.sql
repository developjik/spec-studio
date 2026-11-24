BEGIN IMMEDIATE;
ALTER TABLE proposal ADD COLUMN queued_at TEXT;
ALTER TABLE proposal ADD COLUMN queue_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE proposal ADD COLUMN source TEXT CHECK (source IN ('llm','rule'));
PRAGMA user_version = 16;
COMMIT;
