-- ═══════════════════════════════════════════════════════════════════
-- spec-studio · schema-v2.sql — reserved for the Run surface
-- (worktree · ACP · run log · checkpoints). v1 is complete without these
-- three tables; adding them later is additive.
-- ═══════════════════════════════════════════════════════════════════
PRAGMA user_version = 20;

CREATE TABLE run (
  id          TEXT PRIMARY KEY,                 -- R_...
  task_id     TEXT NOT NULL REFERENCES obj(id) ON DELETE RESTRICT,  -- specnode|pin 만
  worktree    TEXT NOT NULL,
  branch      TEXT NOT NULL,
  agent       TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('plan','build')),
  state       TEXT NOT NULL
              CHECK (state IN ('queued','running','waiting','needs_input','review','done','failed','cancelled')),
  interrupted INTEGER NOT NULL DEFAULT 0 CHECK (interrupted IN (0,1)),  -- outward 후 재시작
  outward_at  TEXT,                             -- 바깥으로 나간 행동 시각
  started_at  TEXT,
  ended_at    TEXT,
  CHECK (state NOT IN ('done','failed') OR ended_at IS NOT NULL)
);
CREATE INDEX run_task ON run(task_id, state);

-- 참조 일관성: v1.0의 run.task_id는 obj.kind에 없는 task를 가리켰다(B2)
CREATE TRIGGER run_task_kind BEFORE INSERT ON run FOR EACH ROW
WHEN (SELECT kind FROM obj WHERE id = NEW.task_id) NOT IN ('specnode','pin')
BEGIN
  SELECT RAISE(ABORT, 'run_task_must_be_specnode_or_pin');
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
  git_ref    TEXT NOT NULL,                     -- 별도 git dir · 원격 없음 · 암호화
  summary    TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, seq)
);
