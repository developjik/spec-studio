-- ═══════════════════════════════════════════════════════════════════
-- spec-studio · migrate-12-13.sql — a document belongs to a project (W4)
--
-- v12 documents were standalone: block, proposal and op_log existed, but a
-- doc row did not say which project or screen it described, and a block had no
-- timestamps. W4 makes the document part of the project it is edited in, so
-- the editor can reopen it and the store can scope a revert to it.
--
-- Everything here is additive (ALTER TABLE ADD COLUMN with NULL defaults), so
-- existing documents and blocks stay exactly as they are.
-- ═══════════════════════════════════════════════════════════════════
PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

ALTER TABLE doc ADD COLUMN project_id TEXT REFERENCES project(id) ON DELETE CASCADE;
ALTER TABLE doc ADD COLUMN screen_id TEXT REFERENCES obj(id) ON DELETE SET NULL;
ALTER TABLE doc ADD COLUMN updated_at TEXT;

ALTER TABLE block ADD COLUMN created_at TEXT;
ALTER TABLE block ADD COLUMN updated_at TEXT;

CREATE INDEX IF NOT EXISTS doc_project ON doc(project_id, screen_id);

PRAGMA user_version = 13;
COMMIT;
