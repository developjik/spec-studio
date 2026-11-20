-- ═══════════════════════════════════════════════════════════════════
-- spec-studio · migrate-13-14.sql — the v1 object graph (6 types · 7 links)
--
-- v13 could store a screen, its pins and a document. v1 adds the four node
-- kinds a screen spec is traced through (requirement, policy, contract, QA)
-- and the seven named links between the six kinds. All of it is additive:
-- the node kinds ride in the existing `obj.kind`/`subtype` columns, so no
-- table is rebuilt and no existing row changes.
-- ═══════════════════════════════════════════════════════════════════
PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

-- v13 always has this table; the guard is for a partial legacy file whose
-- other tables were rebuilt by hand (a support case, not a product path).
CREATE TABLE IF NOT EXISTS link_type (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  src_kinds  TEXT NOT NULL CHECK (json_valid(src_kinds)),
  dst_kinds  TEXT NOT NULL CHECK (json_valid(dst_kinds)),
  suspect_on TEXT NOT NULL DEFAULT '["hash"]' CHECK (json_valid(suspect_on)),
  v1         INTEGER NOT NULL DEFAULT 1 CHECK (v1 IN (0,1))
);

-- The one link the registry already had; QA now verifies a pin as well.
UPDATE link_type
   SET dst_kinds = '["specnode","screen","contract","pin"]'
 WHERE id = 'verifies';

INSERT OR IGNORE INTO link_type (id, name, src_kinds, dst_kinds, v1) VALUES
  ('implements',   '구현한다',        '["screen","pin"]',                    '["specnode"]', 1),
  ('governs',      '규율한다',        '["specnode"]',                        '["screen","pin","specnode"]', 1),
  ('handles_edge', '예외를 처리한다', '["pin","screen","specnode"]',         '["specnode"]', 1),
  ('references',   '참조한다',        '["screen","pin","specnode","contract","verification"]',
                                      '["screen","pin","specnode","contract","verification"]', 1),
  ('derived_from', '도출된다',        '["specnode","contract","verification"]',
                                      '["specnode","contract","verification","pin"]', 1),
  ('blocks',       '막는다',          '["specnode","contract","verification","pin"]',
                                      '["specnode","contract","verification","pin"]', 1);

CREATE TABLE IF NOT EXISTS graph_proposal (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  state      TEXT NOT NULL
             CHECK (state IN ('open','adopted','rejected','reverted')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  payload    TEXT NOT NULL CHECK (json_valid(payload)),
  CHECK (state NOT IN ('adopted','rejected','reverted') OR decided_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS graph_proposal_project ON graph_proposal(project_id, created_at DESC);

PRAGMA user_version = 14;
COMMIT;
