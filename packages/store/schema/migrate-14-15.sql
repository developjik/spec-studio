-- ═══════════════════════════════════════════════════════════════════
-- spec-studio · migrate-14-15.sql — event identity + idea/evidence
--
-- v14 events and ledger rows said what happened but not which device
-- wrote it. v15 stamps every new event/op_log row with a device id
-- (issued once into `meta` when the daemon first opens the database) and
-- gives each event row a uuid (F6, §5.1). It also adds the idea/evidence
-- object kinds (§5.2) and the document kind column (spec | research).
--
-- The obj kind CHECK cannot be altered in place, so the table is rebuilt:
-- copy → drop → rename, then recreate the four indexes and two triggers
-- (DROP TABLE took them along). obj를 참조하는 FK(link, citation, state_def,
-- doc.screen_id)는 이름 기반이라 foreign_keys OFF 상태에서 그대로 살아 있다.
-- Everything else is additive ALTER TABLE ADD COLUMN. Past rows keep
-- device_id NULL — there is no way to guess a device after the fact.
--
-- The whole file is one transaction: a file two versions behind takes the
-- migrations in order, each landing completely or not at all. The two
-- `PRAGMA foreign_keys` lines stay outside it — inside a transaction the
-- pragma is a no-op.
-- ═══════════════════════════════════════════════════════════════════
PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

-- 1. obj 재빌드 (kind CHECK 교체) ────────────────────────────────────
CREATE TABLE obj_new (
  id          TEXT PRIMARY KEY,                 -- G_/I_/N_/S_/P_/C_/V_/E_ + nanoid(12) · idea는 insight와 I_를 공유(§5.2, kind 컬럼이 구분자)
  project_id  TEXT REFERENCES project(id) ON DELETE RESTRICT,
  kind        TEXT NOT NULL
              CHECK (kind IN ('goal','insight','specnode','screen','pin','contract','verification','idea','evidence')),
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
  CHECK (kind NOT IN ('goal','insight','screen','verification','idea','evidence') OR subtype IS NULL),

  -- kind별 상태 머신 (자유 문자열 금지)
  CHECK (kind <> 'goal'         OR coalesce(state IN ('proposed','active','done','dropped'), 0)),
  CHECK (kind <> 'insight'      OR coalesce(state IN ('ai','ai-verified','human'), 0)),
  CHECK (kind <> 'screen'       OR coalesce(state IN ('design','observed','linked','orphan'), 0)),
  CHECK (kind <> 'pin'          OR coalesce(state IN ('open','resolved','orphan'), 0)),
  CHECK (kind <> 'contract'     OR coalesce(state IN ('draft','agreed','applied'), 0)),
  CHECK (kind <> 'verification' OR coalesce(state IN ('pass','fail','blocked'), 0)),
  CHECK (kind <> 'idea'      OR coalesce(state IN ('captured','promoted','archived'), 0)),
  CHECK (kind <> 'evidence'  OR coalesce(state IN ('captured','cited','dismissed'), 0)),
  CHECK (kind <> 'specnode' OR subtype <> 'requirement'
         OR coalesce(state IN ('draft','approved','building','verified'), 0)),
  CHECK (kind <> 'specnode' OR subtype <> 'policy'
         OR coalesce(state IN ('draft','agreed','applied','superseded'), 0)),
  CHECK (kind <> 'specnode' OR subtype <> 'ia'
         OR coalesce(state IN ('draft','agreed'), 0)),

  -- 핀은 부모 화면 없이 존재하지 않는다 (B2의 문장을 DB에서 참으로 만든다)
  CHECK (kind <> 'pin' OR parent_id IS NOT NULL)
);
INSERT INTO obj_new SELECT * FROM obj;
DROP TABLE obj;
-- 이름 변경만 구형 동작(legacy_alter_table, 스키마 재해석 없음)으로 한다:
-- obj를 참조하는 트리거(link_kind_guard_ins·state_def_screen_guard)가 재해석
-- 중 없는 obj를 보고 죽는 것을 막는다. 트리거는 그대로 살아 있어 내렸다
-- 올릴 필요가 없다.
PRAGMA legacy_alter_table = ON;
ALTER TABLE obj_new RENAME TO obj;
PRAGMA legacy_alter_table = OFF;

-- DROP이 지운 종속 객체를 그대로 되살린다 (정의는 schema.sql과 동일)
CREATE INDEX obj_kind    ON obj(kind, subtype, state) WHERE deleted_at IS NULL;
CREATE INDEX obj_parent  ON obj(parent_id);
CREATE INDEX obj_project ON obj(project_id, kind) WHERE deleted_at IS NULL;
CREATE INDEX obj_hash    ON obj(hash);

-- 부모 종류 고정: pin의 부모는 screen, specnode(ia/requirement)의 부모는 specnode.
-- idea·evidence는 부모 없음(§5.2)이므로 목록에 추가된다.
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
    WHEN NEW.kind IN ('goal','insight','screen','contract','verification','idea','evidence')
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

-- 2. doc: 문서 종류와 소프트 삭제 ────────────────────────────────────
ALTER TABLE doc ADD COLUMN kind TEXT NOT NULL DEFAULT 'spec' CHECK (kind IN ('spec','research'));
ALTER TABLE doc ADD COLUMN deleted_at TEXT;

-- 3. 링크 레지스트리: idea는 derived_from의 도착점, evidence는 references의 도착점
UPDATE link_type
   SET dst_kinds = '["specnode","contract","verification","pin","idea"]'
 WHERE id = 'derived_from';
UPDATE link_type
   SET dst_kinds = '["screen","pin","specnode","contract","verification","evidence"]'
 WHERE id = 'references';

-- 4. 이벤트·원장 신원 스탬핑 ─────────────────────────────────────────
ALTER TABLE event ADD COLUMN device_id TEXT;
ALTER TABLE event ADD COLUMN uuid TEXT;
ALTER TABLE op_log ADD COLUMN device_id TEXT;

-- (device_id, seq)가 이벤트의 전역 신원이다. 과거 NULL 행은 서로 중복으로 섞이지
-- 않는다 — SQLite는 NULL을 서로 다른 값으로 본다 — 대신 사후 백필도 할 수 없다.
CREATE UNIQUE INDEX event_device_seq ON event(device_id, seq);

-- 5. 단일 행 메타: device_id 보관처 (가정 A3). 데몬 DB 기동 시 최초 1회 발급.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- The stamp rides inside the transaction: a crash between the
-- schema change and the stamp cannot leave user_version behind the DDL
-- (W5 carry-over W1-M1).
PRAGMA user_version = 15;
COMMIT;

PRAGMA foreign_keys = ON;
