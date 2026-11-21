-- ═══════════════════════════════════════════════════════════════════
-- spec-studio · graph.db — v1.1  (verified on SQLite 3.46.1)
-- This file is the single source of truth. External tools only ever hold
-- copies; the database is where a project actually lives.
-- The v2 tables (run · run_log · checkpoint) are split into schema-v2.sql.
-- ═══════════════════════════════════════════════════════════════════
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;      -- 발행 경로만 FULL (연결 단위 설정)
PRAGMA user_version = 14;

-- 0. 프로젝트 ───────────────────────────────────────────────────
-- One database file is one project. The row is how the file introduces
-- itself; `obj.project_id` says which objects belong to it. Without it the
-- store could read screens and pins but never know whose they were.
CREATE TABLE project (
  id         TEXT PRIMARY KEY,                 -- PRJ_ + nanoid(12)
  name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 1. 기획 객체 ─────────────────────────────────────────────────────
CREATE TABLE obj (
  id          TEXT PRIMARY KEY,                 -- G_/I_/N_/S_/P_/C_/V_ + nanoid(12)
  project_id  TEXT REFERENCES project(id) ON DELETE RESTRICT,
  kind        TEXT NOT NULL
              CHECK (kind IN ('goal','insight','specnode','screen','pin','contract','verification')),
  subtype     TEXT,   -- specnode: ia|requirement|policy · pin: function|policy|exception|state|data|permission · contract: api|state|event
  title       TEXT NOT NULL CHECK (length(title) > 0),
  parent_id   TEXT REFERENCES obj(id) ON DELETE RESTRICT,
  props       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(props)),
  state       TEXT NOT NULL,
  rev         INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  hash        TEXT NOT NULL CHECK (length(hash) > 0),
  deleted_at  TEXT,                             -- tombstone. 물리 삭제하지 않는다
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,

  -- subtype 필수 + kind별 허용값 (3값 논리를 coalesce로 막는다)
  CHECK (kind <> 'specnode' OR coalesce(subtype IN ('ia','requirement','policy'), 0)),
  CHECK (kind <> 'pin'      OR coalesce(subtype IN ('function','policy','exception','state','data','permission'), 0)),
  CHECK (kind <> 'contract' OR coalesce(subtype IN ('api','state','event'), 0)),
  CHECK (kind NOT IN ('goal','insight','screen','verification') OR subtype IS NULL),

  -- kind별 상태 머신 (자유 문자열 금지)
  CHECK (kind <> 'goal'         OR coalesce(state IN ('proposed','active','done','dropped'), 0)),
  CHECK (kind <> 'insight'      OR coalesce(state IN ('ai','ai-verified','human'), 0)),
  CHECK (kind <> 'screen'       OR coalesce(state IN ('design','observed','linked','orphan'), 0)),
  CHECK (kind <> 'pin'          OR coalesce(state IN ('open','resolved','orphan'), 0)),
  CHECK (kind <> 'contract'     OR coalesce(state IN ('draft','agreed','applied'), 0)),
  CHECK (kind <> 'verification' OR coalesce(state IN ('pass','fail','blocked'), 0)),
  CHECK (kind <> 'specnode' OR subtype <> 'requirement'
         OR coalesce(state IN ('draft','approved','building','verified'), 0)),
  CHECK (kind <> 'specnode' OR subtype <> 'policy'
         OR coalesce(state IN ('draft','agreed','applied','superseded'), 0)),
  CHECK (kind <> 'specnode' OR subtype <> 'ia'
         OR coalesce(state IN ('draft','agreed'), 0)),

  -- 핀은 부모 화면 없이 존재하지 않는다 (B2의 문장을 DB에서 참으로 만든다)
  CHECK (kind <> 'pin' OR parent_id IS NOT NULL)
);
CREATE INDEX obj_kind    ON obj(kind, subtype, state) WHERE deleted_at IS NULL;
CREATE INDEX obj_parent  ON obj(parent_id);
CREATE INDEX obj_project ON obj(project_id, kind) WHERE deleted_at IS NULL;
CREATE INDEX obj_hash    ON obj(hash);

-- 부모 종류 고정: pin의 부모는 screen, specnode(ia/requirement)의 부모는 specnode
CREATE TRIGGER obj_parent_kind_ins BEFORE INSERT ON obj FOR EACH ROW
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NEW.kind = 'pin'
         AND (SELECT kind FROM obj WHERE id = NEW.parent_id) IS NOT 'screen'
      THEN RAISE(ABORT, 'pin_parent_must_be_screen')
    WHEN NEW.kind = 'specnode'
         AND (SELECT kind FROM obj WHERE id = NEW.parent_id) IS NOT 'specnode'
      THEN RAISE(ABORT, 'specnode_parent_must_be_specnode')
    WHEN NEW.kind IN ('goal','insight','screen','contract','verification')
         AND NEW.parent_id IS NOT NULL
      THEN RAISE(ABORT, 'kind_has_no_parent')
  END;
END;

-- kind는 불변. 바꾸려면 새 객체 + supersedes 링크 (H7: UPDATE로 의미가 깨지던 구멍)
CREATE TRIGGER obj_kind_immutable BEFORE UPDATE OF kind ON obj FOR EACH ROW
WHEN NEW.kind <> OLD.kind
BEGIN
  SELECT RAISE(ABORT, 'obj.kind_immutable');
END;

-- 2. 문서·블록 ────────────────────────────────────────────────────
-- v13: a document belongs to a project and (when there is one) to the screen
-- it describes. `updated_at` exists so a document can be ordered and reopened
-- like every other object.
CREATE TABLE doc (
  id          TEXT PRIMARY KEY,                 -- D_...
  project_id  TEXT REFERENCES project(id) ON DELETE CASCADE,
  screen_id   TEXT REFERENCES obj(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  rev         INTEGER NOT NULL DEFAULT 0,       -- 커밋 단위로 증가
  created_at  TEXT NOT NULL,
  updated_at  TEXT
);
CREATE INDEX doc_project ON doc(project_id, screen_id);

CREATE TABLE block (
  id         TEXT PRIMARY KEY,                  -- B_ + nanoid(12)
  doc_id     TEXT NOT NULL REFERENCES doc(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES block(id) ON DELETE RESTRICT,   -- SET NULL 금지 (구조 손상)
  idx        TEXT NOT NULL,                     -- fractional index (문서 순서)
  type       TEXT NOT NULL
             CHECK (type IN ('paragraph','heading','list','table','table_row','table_cell',
                             'caption','figure','code','criteria')),
  text       TEXT NOT NULL DEFAULT '',
  -- attrs carries what the block stands on: {"pinRefs":[{pinId,fingerprint,linkedAt}]}
  attrs      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attrs)),
  hash       TEXT NOT NULL CHECK (length(hash) > 0),
  state      TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live','deleted')),
  commit_seq INTEGER,                           -- 이 블록을 마지막으로 바꾼 op_log.seq
  created_at TEXT,
  updated_at TEXT,
  parent_key TEXT GENERATED ALWAYS AS (coalesce(parent_id, '')) VIRTUAL
);
CREATE INDEX block_doc ON block(doc_id, idx);
CREATE UNIQUE INDEX block_sibling ON block(doc_id, parent_key, idx) WHERE state = 'live';
CREATE INDEX block_parent ON block(parent_id);

-- 표는 block 1행 + table_row 자식 + table_cell 자식 (제안 셀렉터가 가리킬 실체)
CREATE TRIGGER block_table_guard BEFORE INSERT ON block FOR EACH ROW
WHEN NEW.type IN ('table_row','table_cell') AND NEW.parent_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'table_row_needs_table_parent');
END;

-- 3. 캔버스: 그림이 아니라 JSON (xyflow 데이터 모델과 1:1) ───────────
CREATE TABLE flow (
  id      TEXT PRIMARY KEY,                     -- F_...
  project TEXT NOT NULL DEFAULT 'default',
  kind    TEXT NOT NULL CHECK (kind IN ('node','edge')),
  ref     TEXT,                                 -- node: obj/block id
  src     TEXT,                                 -- edge: flow node id
  dst     TEXT,
  label   TEXT,
  x       REAL NOT NULL DEFAULT 0,
  y       REAL NOT NULL DEFAULT 0,
  w       REAL,
  h       REAL,
  z       REAL NOT NULL DEFAULT 0,
  data    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  CHECK (kind <> 'node' OR ref IS NOT NULL),
  CHECK (kind <> 'edge' OR (src IS NOT NULL AND dst IS NOT NULL))
);
CREATE INDEX flow_project ON flow(project, kind);
CREATE INDEX flow_ref     ON flow(ref);

-- 4. 타입 있는 링크 ───────────────────────────────────────────────
CREATE TABLE link_type (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  src_kinds  TEXT NOT NULL CHECK (json_valid(src_kinds)),
  dst_kinds  TEXT NOT NULL CHECK (json_valid(dst_kinds)),
  suspect_on TEXT NOT NULL DEFAULT '["hash"]' CHECK (json_valid(suspect_on)),
  v1         INTEGER NOT NULL DEFAULT 1 CHECK (v1 IN (0,1))   -- v1 UI 노출 여부
);

CREATE TABLE link (
  id            TEXT PRIMARY KEY,               -- L_...
  type          TEXT NOT NULL REFERENCES link_type(id),
  src           TEXT NOT NULL REFERENCES obj(id) ON DELETE RESTRICT,
  dst           TEXT NOT NULL REFERENCES obj(id) ON DELETE RESTRICT,
  suspect_since TEXT,
  suspect_why   TEXT,
  suspect_rev   INTEGER,                        -- (obj, rev) 기준 1회만 발화
  acked_by      TEXT,
  acked_at      TEXT,
  created_at    TEXT NOT NULL,
  CHECK (src <> dst)
);
CREATE UNIQUE INDEX link_once  ON link(type, src, dst);
CREATE INDEX link_src          ON link(src, type);          -- auto-suspect 질의용
CREATE INDEX link_dst          ON link(dst, suspect_since);
CREATE INDEX link_queue        ON link(suspect_since) WHERE suspect_since IS NOT NULL AND acked_at IS NULL;

-- 링크 타입의 src/dst kind 계약을 트리거로 강제 (TEXT JSON만 두면 의미가 조용히 깨진다)
-- 레지스트리 7종. v1 화면은 v1=1인 4종만 노출하고, 나머지는 데이터 변경 없이 켠다.
INSERT INTO link_type (id, name, src_kinds, dst_kinds, v1) VALUES
  ('derives',    '도출한다', '["goal","insight"]',        '["specnode"]',  1),
  ('applies_to', '적용된다', '["specnode"]',              '["screen","pin"]', 1),
  ('contracts',  '계약한다', '["screen","specnode"]',     '["contract"]',  1),
  ('verifies',   '검증한다', '["verification"]',          '["specnode","screen","contract","pin"]', 1),
  ('expresses',  '표현한다', '["specnode"]',              '["screen"]',    0),
  ('satisfies',  '충족한다', '["screen","specnode"]',     '["specnode"]',  0),
  ('supersedes', '뒤집는다', '["specnode"]',              '["specnode"]',  0);

-- v1 object graph: the seven named links a screen spec is traced with. Four
-- of them are new here; `verifies` above already carried the same meaning, so
-- it is the one row that did not need adding.
INSERT INTO link_type (id, name, src_kinds, dst_kinds, v1) VALUES
  ('implements',   '구현한다',        '["screen","pin"]',                    '["specnode"]', 1),
  ('governs',      '규율한다',        '["specnode"]',                        '["screen","pin","specnode"]', 1),
  ('handles_edge', '예외를 처리한다', '["pin","screen","specnode"]',         '["specnode"]', 1),
  ('references',   '참조한다',        '["screen","pin","specnode","contract","verification"]',
                                      '["screen","pin","specnode","contract","verification"]', 1),
  ('derived_from', '도출된다',        '["specnode","contract","verification"]',
                                      '["specnode","contract","verification","pin"]', 1),
  ('blocks',       '막는다',          '["specnode","contract","verification","pin"]',
                                      '["specnode","contract","verification","pin"]', 1);

CREATE TRIGGER link_kind_guard_ins BEFORE INSERT ON link FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM link_type lt, obj s, obj d
  WHERE lt.id = NEW.type AND s.id = NEW.src AND d.id = NEW.dst
    AND EXISTS (SELECT 1 FROM json_each(lt.src_kinds) WHERE json_each.value = s.kind)
    AND EXISTS (SELECT 1 FROM json_each(lt.dst_kinds) WHERE json_each.value = d.kind)
)
BEGIN
  SELECT RAISE(ABORT, 'link_kind_mismatch');
END;

-- 5. 인용: 문장·문단 단위까지 되짚는다 ────────────────────────────
CREATE TABLE citation (
  id          TEXT PRIMARY KEY,
  claim_id    TEXT NOT NULL REFERENCES obj(id) ON DELETE RESTRICT,
  block_id    TEXT REFERENCES block(id) ON DELETE RESTRICT,   -- 문장 단위 인용
  source_kind TEXT NOT NULL
              CHECK (source_kind IN ('mail','slack','ticket','review','meeting','attachment','capture','url')),
  source_ref  TEXT NOT NULL,
  quote       TEXT NOT NULL CHECK (length(quote) > 0),        -- 원문 복사
  at          TEXT,
  author      TEXT
);
CREATE INDEX citation_claim ON citation(claim_id);
CREATE INDEX citation_block ON citation(block_id);

-- 6. 제안: 본문 밖의 편집 계층 ────────────────────────────────────
CREATE TABLE proposal (
  id           TEXT PRIMARY KEY,                -- PR_...
  doc_id       TEXT NOT NULL REFERENCES doc(id) ON DELETE RESTRICT,
  origin       TEXT NOT NULL CHECK (origin IN ('doc-chat','pin','screen','table-cell','paste')),
  summary      TEXT NOT NULL,
  base_rev     INTEGER NOT NULL,                -- 제안이 딛고 선 doc.rev
  author_kind  TEXT NOT NULL CHECK (author_kind IN ('ai','human')),
  author_id    TEXT,
  risk         TEXT NOT NULL DEFAULT 'medium' CHECK (risk IN ('low','medium','high')),
  state        TEXT NOT NULL
               CHECK (state IN ('open','reviewing','adopted','rejected','superseded')),
  created_at   TEXT NOT NULL,
  decided_at   TEXT,
  CHECK (state NOT IN ('adopted','rejected') OR decided_at IS NOT NULL)
);
CREATE INDEX proposal_doc ON proposal(doc_id, state);

CREATE TABLE proposal_op (
  id           TEXT PRIMARY KEY,                -- op_...
  proposal_id  TEXT NOT NULL REFERENCES proposal(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,                -- 제안 내 선언 순서 (적용 순서)
  kind         TEXT NOT NULL CHECK (kind IN ('insert','replace','delete','move')),
  target_block TEXT REFERENCES block(id) ON DELETE RESTRICT,
  target_obj   TEXT REFERENCES obj(id) ON DELETE RESTRICT,
  base_hash    TEXT,                            -- target 블록의 커밋 해시
  base_text    TEXT,                            -- 3-way patch의 조상 (문자 범위 대신 블록 전문)
  new_text     TEXT,
  row_index    INTEGER,                         -- 표 행 셀렉터: target_block + row_index
  cell_index   INTEGER,
  view         TEXT NOT NULL CHECK (json_valid(view)),
  marks        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(marks)),
  state        TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','adopted','rejected','stale')),
  decision     TEXT CHECK (decision IN ('keep','replace','discard')),  -- 3손 구분 보존
  verified     INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  CHECK (target_block IS NULL OR target_obj IS NULL),
  CHECK (kind = 'insert' OR target_block IS NOT NULL OR target_obj IS NOT NULL)
);
CREATE UNIQUE INDEX proposal_op_seq ON proposal_op(proposal_id, seq);
CREATE INDEX proposal_op_target ON proposal_op(target_block);

-- 6b. 핀에서 읽은 초안: 제안 1건 = 결정 카드 1장 ────────────────────
-- The W4 proposal layer edits document blocks; this one creates graph nodes
-- and links. They share the word "proposal" but not a table, because adopting
-- each means a different write and a different undo. `payload` is the JSON the
-- protocol already validates, so the store keeps no second copy of its shape.
CREATE TABLE graph_proposal (
  id         TEXT PRIMARY KEY,                  -- GP_...
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  state      TEXT NOT NULL
             CHECK (state IN ('open','adopted','rejected','reverted')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  payload    TEXT NOT NULL CHECK (json_valid(payload)),
  CHECK (state NOT IN ('adopted','rejected','reverted') OR decided_at IS NOT NULL)
);
CREATE INDEX graph_proposal_project ON graph_proposal(project_id, created_at DESC);

-- 7. 상태 레지스트리 L0/L1/L2 ─────────────────────────────────────
CREATE TABLE state_def (
  id        TEXT PRIMARY KEY,                   -- ST_...
  screen_id TEXT NOT NULL REFERENCES obj(id) ON DELETE RESTRICT,
  name      TEXT NOT NULL
            CHECK (name IN ('default','loading','empty','error','no_permission','partial')),
  level     TEXT NOT NULL DEFAULT 'L2' CHECK (level IN ('L0','L1','L2')),
  ref       TEXT,                               -- L0: image/figma_frame URL·경로
  seed      TEXT CHECK (seed IS NULL OR (json_valid(seed) AND json_type(seed) <> 'null')),
  selectors TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(selectors)),
  viewport  TEXT NOT NULL DEFAULT '1280x900',
  evidence  INTEGER NOT NULL DEFAULT 0 CHECK (evidence IN (0,1)),
  UNIQUE (screen_id, name),
  CHECK (level <> 'L0' OR ref IS NOT NULL),
  CHECK (level <> 'L1' OR (seed IS NOT NULL OR selectors <> '{}')),
  CHECK (level <> 'L2' OR (seed IS NOT NULL AND selectors <> '{}')),
  CHECK (evidence = 0 OR level = 'L2')
);
CREATE TRIGGER state_def_screen_guard BEFORE INSERT ON state_def FOR EACH ROW
WHEN (SELECT kind FROM obj WHERE id = NEW.screen_id) IS NOT 'screen'
BEGIN
  SELECT RAISE(ABORT, 'state_def_needs_screen');
END;

CREATE TABLE capture (
  id         TEXT PRIMARY KEY,
  state_id   TEXT NOT NULL REFERENCES state_def(id) ON DELETE RESTRICT,
  commit_sha TEXT,                              -- L0/L1은 NULL 허용
  viewport   TEXT NOT NULL,
  image      TEXT NOT NULL,                     -- captures/<screen>/<state>-<sha>.png
  image_sha  TEXT NOT NULL,
  bytes      INTEGER,
  dom_hash   TEXT,
  taken_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX capture_once ON capture(state_id, image_sha);
CREATE INDEX capture_state ON capture(state_id, taken_at DESC);

-- 8. 발행 기록: 사본을 어디로 보냈고 무엇을 돌려받았나 ──────────────
-- W3 publishes a screen spec, not a document: such a row names its project and
-- screen and carries the spec_hash it copied, so re-publishing the same spec
-- after a restart is a lookup, not a second page. A document publish still
-- names its doc. Exactly one of the two owners is set.
CREATE TABLE publish_record (
  id             TEXT PRIMARY KEY,              -- PB_...
  doc_id         TEXT REFERENCES doc(id) ON DELETE RESTRICT,
  project_id     TEXT REFERENCES project(id) ON DELETE CASCADE,
  screen_id      TEXT REFERENCES obj(id) ON DELETE SET NULL,
  target         TEXT NOT NULL CHECK (target IN ('confluence','notion','jira','local')),
  space_key      TEXT,                          -- Confluence space (id or key as entered)
  page_id        TEXT,                          -- 원격 페이지 id
  version        INTEGER,                       -- 원격 판 번호 (REST) 또는 null (MCP)
  snapshot_token TEXT,                          -- Rovo MCP v2 스냅샷 토큰
  output_kind    TEXT NOT NULL
                 CHECK (output_kind IN ('body','overlay-png','spec-html','qa-csv','bundle')),
  artifact       TEXT,                          -- 파일 경로 또는 해시
  status         TEXT NOT NULL CHECK (status IN ('intent','ok','failed','blocked')),
  spec_hash      TEXT,                          -- 발행한 스펙 내용 해시 (멱등성 판단)
  remote_url     TEXT,                          -- 원격 페이지 주소
  idem_key       TEXT NOT NULL,                 -- 재시작 중복 발행 방지
  note           TEXT,
  published_at   TEXT,
  at             TEXT NOT NULL,
  CHECK (doc_id IS NOT NULL OR project_id IS NOT NULL),
  CHECK (status <> 'ok' OR project_id IS NULL
         OR (page_id IS NOT NULL AND spec_hash IS NOT NULL AND published_at IS NOT NULL))
);
CREATE UNIQUE INDEX publish_idem ON publish_record(target, idem_key);
CREATE INDEX publish_doc ON publish_record(doc_id, at DESC);
CREATE INDEX publish_project ON publish_record(project_id, at DESC);
CREATE UNIQUE INDEX publish_version ON publish_record(doc_id, target, page_id, version)
  WHERE version IS NOT NULL;

-- 9. 이벤트: 전역 seq + 스레드 커서 ───────────────────────────────
CREATE TABLE thread (
  id         TEXT PRIMARY KEY,                  -- doc:D_... / project:PRJ_... / agent:R_...
  kind       TEXT NOT NULL CHECK (kind IN ('doc','project','publish','agent','ui')),
  last_seq   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE event (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,  -- 전역 단조 증가
  thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  type      TEXT NOT NULL,                      -- object.upsert / link.suspect / proposal.open …
  payload   TEXT NOT NULL CHECK (json_valid(payload)),
  at        TEXT NOT NULL
);
CREATE INDEX event_thread ON event(thread_id, seq);

-- 스레드별 단조 증가를 DB가 보장한다 (B4: 문서에만 있던 규칙)
CREATE TRIGGER event_bump AFTER INSERT ON event FOR EACH ROW
BEGIN
  UPDATE thread SET last_seq = NEW.seq WHERE id = NEW.thread_id;
END;

-- 10. 원장: before/after를 남겨 undo 계약을 실제로 성립시킨다 ───────
CREATE TABLE op_log (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  actor    TEXT NOT NULL,                       -- person:<id> | ai:<run> | system
  kind     TEXT NOT NULL,                       -- block.update / proposal.adopt / publish …
  target   TEXT,
  before   TEXT CHECK (before IS NULL OR json_valid(before)),
  after    TEXT CHECK (after IS NULL OR json_valid(after)),
  payload  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  CHECK (kind NOT IN ('block.update','block.delete','proposal.adopt') OR before IS NOT NULL)
);
CREATE INDEX op_log_target ON op_log(target, seq DESC);

-- 11. UI 상태 (URL이 정본, 이 표는 복원 캐시) ─────────────────────
CREATE TABLE ui_state (
  project   TEXT PRIMARY KEY,
  surface   TEXT NOT NULL CHECK (surface IN ('plan','doc','screen')),
  object_id TEXT,
  sel       TEXT CHECK (sel IS NULL OR json_valid(sel)),
  state     TEXT
);

-- 12. 검색: trigram + 한글 음절 바이그램 보조 + 청크 매핑 ───────────
-- @optional-fts5
-- FTS5은 SQLite 빌드 옵션이다. Node가 함께 배포하는 SQLite에는 빠져 있을 수
-- 있으므로 런타임 어댑터는 이 줄 아래만 건너뛴다 — 검색 인덱스가 없어도
-- 프로젝트·화면·핀은 그대로 저장된다. 계약 시험은 항상 이 절까지 적용해
-- 스키마 전체(80 objects)를 검사한다.
CREATE TABLE search_chunk (
  id       INTEGER PRIMARY KEY,                 -- search.rowid와 동일
  block_id TEXT NOT NULL REFERENCES block(id) ON DELETE CASCADE,
  ord      INTEGER NOT NULL,
  norm     TEXT NOT NULL,                       -- NFC + 공백 정규화 + 조사 제거 사전
  UNIQUE (block_id, ord)
);
CREATE INDEX search_chunk_block ON search_chunk(block_id);

CREATE VIRTUAL TABLE search USING fts5(
  body, norm,
  tokenize = 'trigram'
);

CREATE VIRTUAL TABLE search_bi USING fts5(
  bi,                                           -- 음절 바이그램을 공백으로 이어 붙인 토큰 열
  tokenize = 'unicode61'
);
