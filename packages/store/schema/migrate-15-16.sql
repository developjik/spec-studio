-- ═══════════════════════════════════════════════════════════════════
-- spec-studio · migrate-15-16.sql — E2 W0 스키마 전부 additive
--
-- Three changes, all additive to data already on disk:
--
-- 1. doc.kind gains 'backlog' (§4.1 ① — the backlog document W1 fills).
--    The CHECK cannot be altered in place, so the table is rebuilt with
--    the same copy → drop → rename pattern the v15 obj rebuild used.
--    block/proposal/publish_record FK들은 이름 기반이라 foreign_keys OFF
--    상태에서 그대로 살아 있다; DROP이 지운 doc_project 인덱스는 되살린다.
--    doc에는 트리거가 없어 되살릴 것이 인덱스 하나뿐이다.
--
-- 2. proposal.idea_id (§4.1 ② / MN-A). 브리프가 답한 아이디어를 실어
--    나르는 유일한 내구 수단 — 세션 Map이 재시작마다 지워지던 구멍을 닫는다.
--    과거 행은 NULL — 어떤 아이디어에서 왔는지 사후에 추측할 수 없다.
--
-- 3. journey.* 이벤트는 스키마 변경이 필요 없다: event.type은 CHECK 없는
--    자유 TEXT라 어떤 종류도 그대로 기록된다 (§4.1 ⑤ — 불필요 enum 추가 금지).
--
-- The stamp rides inside the transaction, same promise as every earlier
-- migration: the DDL and the user_version commit or roll back together.
-- ═══════════════════════════════════════════════════════════════════
PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

-- 1. doc 재빌드 (kind CHECK에 'backlog' 추가) ─────────────────────────
-- 두 FK 동작은 신규 생성 경로(schema.sql)와 반드시 같아야 한다 — 이관 파일과
-- 신규 파일의 삭제 동작이 갈리면 그 차이가 영구히 굳는다.
CREATE TABLE doc_new (
  id          TEXT PRIMARY KEY,                 -- D_ + nanoid(12)
  project_id  TEXT REFERENCES project(id) ON DELETE CASCADE,
  screen_id   TEXT REFERENCES obj(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  rev         INTEGER NOT NULL DEFAULT 0,       -- 커밋 단위로 증가
  created_at  TEXT NOT NULL,
  updated_at  TEXT,
  kind        TEXT NOT NULL DEFAULT 'spec' CHECK (kind IN ('spec','research','backlog')),
  deleted_at  TEXT
);
-- 컬럼을 양쪽 다 명시한다. 이관으로 올라온 doc은 ADD COLUMN이 뒤에 붙어
-- (id,title,rev,created_at,project_id,screen_id,updated_at,kind,deleted_at)
-- 신규 생성 순서와 다르다 — positional SELECT *는 NULL인 project_id를
-- NOT NULL rev에 밀어 넣어 15→16이 실패했다 (검증자 Blocker 1).
INSERT INTO doc_new (id, project_id, screen_id, title, rev, created_at, updated_at, kind, deleted_at)
SELECT id, project_id, screen_id, title, rev, created_at, updated_at, kind, deleted_at FROM doc;
DROP TABLE doc;
PRAGMA legacy_alter_table = ON;
ALTER TABLE doc_new RENAME TO doc;
PRAGMA legacy_alter_table = OFF;

CREATE INDEX doc_project ON doc(project_id, screen_id);

-- 2. proposal에 아이디어 참조 ─────────────────────────────────────────
ALTER TABLE proposal ADD COLUMN idea_id TEXT;

PRAGMA user_version = 16;
COMMIT;

PRAGMA foreign_keys = ON;
