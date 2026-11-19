-- ═══════════════════════════════════════════════════════════════════
-- spec-studio · migrate-11-12.sql — publish records name a project (W3)
--
-- v11 tied every publish record to a document. W3 publishes a screen spec,
-- so a record needs project_id / screen_id / spec_hash / remote_url /
-- published_at and a nullable doc_id. SQLite cannot drop NOT NULL in place,
-- so the table is rebuilt. Existing document rows move across unchanged.
-- ═══════════════════════════════════════════════════════════════════
PRAGMA foreign_keys = OFF;

CREATE TABLE publish_record_v12 (
  id             TEXT PRIMARY KEY,
  doc_id         TEXT REFERENCES doc(id) ON DELETE RESTRICT,
  project_id     TEXT REFERENCES project(id) ON DELETE CASCADE,
  screen_id      TEXT REFERENCES obj(id) ON DELETE SET NULL,
  target         TEXT NOT NULL CHECK (target IN ('confluence','notion','jira','local')),
  space_key      TEXT,
  page_id        TEXT,
  version        INTEGER,
  snapshot_token TEXT,
  output_kind    TEXT NOT NULL
                 CHECK (output_kind IN ('body','overlay-png','spec-html','qa-csv','bundle')),
  artifact       TEXT,
  status         TEXT NOT NULL CHECK (status IN ('intent','ok','failed','blocked')),
  spec_hash      TEXT,
  remote_url     TEXT,
  idem_key       TEXT NOT NULL,
  note           TEXT,
  published_at   TEXT,
  at             TEXT NOT NULL,
  CHECK (doc_id IS NOT NULL OR project_id IS NOT NULL),
  CHECK (status <> 'ok' OR project_id IS NULL
         OR (page_id IS NOT NULL AND spec_hash IS NOT NULL AND published_at IS NOT NULL))
);

INSERT INTO publish_record_v12
  (id, doc_id, target, page_id, version, snapshot_token, output_kind, artifact,
   status, idem_key, note, at)
SELECT id, doc_id, target, page_id, version, snapshot_token, output_kind, artifact,
       status, idem_key, note, at
  FROM publish_record;

DROP TABLE publish_record;
ALTER TABLE publish_record_v12 RENAME TO publish_record;

CREATE UNIQUE INDEX publish_idem ON publish_record(target, idem_key);
CREATE INDEX publish_doc ON publish_record(doc_id, at DESC);
CREATE INDEX publish_project ON publish_record(project_id, at DESC);
CREATE UNIQUE INDEX publish_version ON publish_record(doc_id, target, page_id, version)
  WHERE version IS NOT NULL;

PRAGMA user_version = 12;
PRAGMA foreign_keys = ON;
