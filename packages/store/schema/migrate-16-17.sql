-- ═══════════════════════════════════════════════════════════════════
-- spec-studio · migrate-16-17.sql — E3 W0: 런 서페이스 활성화
--
-- Pure CREATE — no table that already exists is touched, so every row on
-- disk crosses unchanged (AC-10 additive). The DDL below is byte-identical
-- to section 13 of schema.sql; v17.test.ts asserts that parity, because a
-- migrated file and a fresh file must never drift.
--
-- Four corrections ride along (spec §4.1 B2, 확정 2026-11-22) — the reserved
-- DDL assumed coding runs; E3's first citizen is the idea→brief research
-- run, which has no git to point at:
--   ① run_task_kind 트리거에 'idea' 허용 — 아이디어→브리프 리서치 런의 과제
--   ② mode CHECK에 'research' 추가
--   ③ run.worktree·branch NULL 허용 — 리서치런은 워크트리가 없다
--   ④ checkpoint.git_ref NULL 허용 — 대화 상태 체크포인트는 git이 아니다
-- thread.kind 'agent' 는 v11부터 CHECK에 들어 있었다 — 활성이지 추가가 아니다.
-- ═══════════════════════════════════════════════════════════════════
BEGIN IMMEDIATE;

CREATE TABLE run (
  id          TEXT PRIMARY KEY,                 -- R_...
  task_id     TEXT NOT NULL REFERENCES obj(id) ON DELETE RESTRICT,  -- specnode|pin|idea
  worktree    TEXT,                             -- B2 ③: 코딩런에만 있다
  branch      TEXT,                             -- B2 ③
  agent       TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('plan','build','research')),  -- B2 ②
  state       TEXT NOT NULL
              CHECK (state IN ('queued','running','waiting','needs_input','review','done','failed','cancelled')),
  interrupted INTEGER NOT NULL DEFAULT 0 CHECK (interrupted IN (0,1)),  -- outward 후 재시작
  outward_at  TEXT,                             -- 바깥으로 나간 행동 시각
  started_at  TEXT,
  ended_at    TEXT,
  CHECK (state NOT IN ('done','failed') OR ended_at IS NOT NULL)
);
CREATE INDEX run_task ON run(task_id, state);

-- 참조 일관성: 과제는 그래프에 실재하는 객체여야 한다 (B2 ① — idea 포함)
CREATE TRIGGER run_task_kind BEFORE INSERT ON run FOR EACH ROW
WHEN (SELECT kind FROM obj WHERE id = NEW.task_id) NOT IN ('specnode','pin','idea')
BEGIN
  SELECT RAISE(ABORT, 'run_task_must_be_specnode_pin_or_idea');
END;

-- 런 로그는 메모리 링이 아니라 표에 남는다 (B4: 재기동 후 빈 화면 방지)
CREATE TABLE run_log (
  run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  seq    INTEGER NOT NULL,
  at     TEXT NOT NULL,
  stream TEXT NOT NULL CHECK (stream IN ('stdout','stderr','event')),
  line   TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE checkpoint (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  git_ref    TEXT,                              -- B2 ④: 코딩런 체크포인트에만 있다
  summary    TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, seq)
);

PRAGMA user_version = 17;
COMMIT;
