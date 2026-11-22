import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasFts5, openSqliteStore, splitSchema, type SqliteStore } from '../src';

/** The v14 canon DDL, frozen as a fixture: this is what a real v14 file looks
 *  like — and what the installed file on this machine measured (2026-11-22).
 *  The v11-origin path stays covered by v16.test.ts; the 16→17 step below is
 *  pure CREATE, identical for every origin. */
const FIXTURE = fileURLToPath(new URL('./fixtures/schema-v14.sql', import.meta.url));

const AT = '2026-11-19T09:00:00.000Z';

let dir = '';
let file = '';
let clock = 0;
const stores: SqliteStore[] = [];

function tick(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 10, 19, 9, 0, clock)).toISOString();
}

function open(options: { deviceId?: string } = {}): SqliteStore {
  const store = openSqliteStore({ file, clock: tick, ...options });
  stores.push(store);
  return store;
}

function applyV14(path: string): void {
  const raw = new DatabaseSync(path);
  const { core, search } = splitSchema(readFileSync(FIXTURE, 'utf8'));
  raw.exec(core);
  if (hasFts5(raw)) raw.exec(search);
  raw.close();
}

/** One real-shaped v14 project (v16.test.ts's seed) plus the two objects the
 *  v17 trigger contract needs: an idea (allowed as a run task — B2) rides
 *  along; the seeded screen doubles as the rejected kind. */
function seedV14(path: string): void {
  const raw = new DatabaseSync(path);
  raw.exec(`
    INSERT INTO project(id,name,created_at,updated_at)
      VALUES('PRJ_migration01','주문 상세 기획','${AT}','${AT}');
    INSERT INTO obj(id,project_id,kind,subtype,title,parent_id,props,state,rev,hash,created_at,updated_at)
      VALUES('S_migration0001','PRJ_migration01','screen',NULL,'주문 상세',NULL,
             '{"code":"SCR-110","ref":{"kind":"image","value":"data:image/svg+xml,%3Csvg%3E","label":"샘플 화면"},"figmaUrl":null,"viewport":{"width":1200,"height":800},"pinSeq":1}',
             'linked',1,'h-screen','${AT}','${AT}');
    INSERT INTO obj(id,project_id,kind,subtype,title,parent_id,props,state,rev,hash,created_at,updated_at)
      VALUES('P_migration0001','PRJ_migration01','pin','policy','배송 시작 후 취소 불가','S_migration0001',
             '{"number":1,"body":"배송 시작 전에만 취소 가능","anchor":{"x":0.5,"y":0.4}}',
             'open',1,'h-pin','${AT}','${AT}');
    INSERT INTO obj(id,project_id,kind,subtype,title,parent_id,props,state,rev,hash,created_at,updated_at)
      VALUES('N_migration0001','PRJ_migration01','specnode','requirement','취소 요청',NULL,
             '{"body":"배송 전 취소 요청을 받는다"}','draft',1,'h-req','${AT}','${AT}');
    INSERT INTO doc(id,project_id,screen_id,title,rev,created_at,updated_at)
      VALUES('D_migration0001','PRJ_migration01','S_migration0001','주문 상세 문서',2,'${AT}','${AT}');
    INSERT INTO block(id,doc_id,parent_id,idx,type,text,attrs,hash,state,created_at,updated_at)
      VALUES('B_migration0001','D_migration0001',NULL,'000000','paragraph',
             '배송이 시작되기 전까지만 취소할 수 있다.','{"pinRefs":[]}','h-b1','live','${AT}','${AT}');
    INSERT INTO link(id,type,src,dst,created_at)
      VALUES('L_migration0001','implements','P_migration0001','N_migration0001','${AT}');
    INSERT INTO proposal(id,doc_id,origin,summary,base_rev,author_kind,risk,state,created_at)
      VALUES('PR_migration0001','D_migration0001','pin','취소 문장을 좁힌다',2,'ai','low','open','${AT}');
    INSERT INTO proposal_op(id,proposal_id,seq,kind,target_block,view,state)
      VALUES('op_migration0001','PR_migration0001',1,'insert','B_migration0001',
             '{"blockId":"B_migration0001","afterBlockId":null,"before":null,"after":{"type":"paragraph","text":"추가","pinRefs":[]}}','open');
    INSERT INTO op_log(at,actor,kind,target,before,after,payload)
      VALUES('${AT}','person:owner','pin.create','P_migration0001',NULL,'{}','{}');
    INSERT INTO thread(id,kind,last_seq,created_at)
      VALUES('project:PRJ_migration01','project',1,'${AT}');
    INSERT INTO event(thread_id,type,payload,at)
      VALUES('project:PRJ_migration01','pin.created','{"pinId":"P_migration0001"}','${AT}');
  `);
  raw.close();
}

/** DDL of every v17 run-surface object in a database, normalised for compare. */
function runDdl(db: DatabaseSync): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE name IN ('run','run_log','checkpoint','run_task','run_task_kind')`,
    )
    .all() as Array<{ name: string; sql: string | null }>;
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.name, (row.sql ?? '').replace(/\s+/g, ' ').trim());
  }
  return map;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spec-studio-v17-'));
  file = join(dir, 'graph.db');
  clock = 0;
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The v14 file cannot hold an idea — its CHECK predates the kind. The chain
 *  grants it; this is what a post-migration capture looks like. */
function seedIdea(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO obj(id,project_id,kind,subtype,title,parent_id,props,state,rev,hash,created_at,updated_at)
     VALUES('I_migration0001','PRJ_migration01','idea',NULL,'경쟁 서비스 취소 정책 조사',NULL,
            '{"body":"경쟁 3사의 취소 정책을 조사해 브리프로 만든다"}','captured',1,'h-idea','${AT}','${AT}')`,
  ).run();
}

describe('v14 → v15 → v16 → v17 migration chain', () => {
  it('moves a real v14 file to 17 without losing a row', async () => {
    applyV14(file);
    seedV14(file);

    const store = open();
    expect(store.schema.actual).toBe(17);
    expect(store.schema.created).toBe(false);

    const db = store.database;
    const count = (sql: string): number => {
      const row = db.prepare(sql).get() as { c: number | bigint } | undefined;
      return Number(row?.c ?? 0);
    };
    expect(count('SELECT count(*) c FROM obj')).toBe(3); // idea cannot exist in v14; it rides in below
    expect(count('SELECT count(*) c FROM doc')).toBe(1);
    expect(count('SELECT count(*) c FROM block')).toBe(1);
    expect(count('SELECT count(*) c FROM link')).toBe(1);
    expect(count('SELECT count(*) c FROM proposal')).toBe(1);
    expect(count('SELECT count(*) c FROM op_log')).toBe(1);
    expect(count('SELECT count(*) c FROM event')).toBe(1);

    // The run surface came into being empty — nothing carried, nothing lost.
    expect(count('SELECT count(*) c FROM run')).toBe(0);
    expect(count('SELECT count(*) c FROM run_log')).toBe(0);
    expect(count('SELECT count(*) c FROM checkpoint')).toBe(0);
  });

  it('keeps the run surface (5 objects) byte-identical between a migrated and a fresh v17 file', () => {
    // W0 검증 Minor-1 정정: 이 검사는 런 서페이스 5객체(run·run_log·checkpoint·
    // run_task·run_task_kind)만 대상이다. 전체 DDL은 아니다 — 6표(doc·event·
    // meta·obj·op_log·proposal)에 부모 커밋부터 내려온 코스메틱 드리프트(따옴표
    // 식별자·주석·개행)가 있어 전체 파리티를 주장하면 안 된다(검증자 판정서 참조).
    applyV14(file);
    seedV14(file);
    const migrated = open();
    expect(migrated.schema.actual).toBe(17);

    const freshFile = join(dir, 'fresh.db');
    const freshRaw = new DatabaseSync(freshFile);
    const { core, search } = splitSchema(readFileSync(
      fileURLToPath(new URL('../schema/schema.sql', import.meta.url)),
      'utf8',
    ));
    freshRaw.exec(core);
    if (hasFts5(freshRaw)) freshRaw.exec(search);
    const versionRow = freshRaw.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(Number(versionRow.user_version)).toBe(17);
    expect(runDdl(migrated.database)).toEqual(runDdl(freshRaw));
    freshRaw.close();
  });
});

describe('v17 — run surface constraints (B2 예약 DDL 확장)', () => {
  /** A migrated file with the schema live; assertions hit it raw. */
  function migrated(): SqliteStore {
    applyV14(file);
    seedV14(file);
    const store = open();
    expect(store.schema.actual).toBe(17);
    seedIdea(store.database); // the run task every test below points at
    return store;
  }

  it('accepts an idea task with no worktree and mode research', () => {
    const db = migrated().database;
    db.prepare(
      `INSERT INTO run(id,task_id,worktree,branch,agent,mode,state)
       VALUES('R_migration0001','I_migration0001',NULL,NULL,'researcher','research','queued')`,
    ).run();
    const run = db.prepare('SELECT task_id, worktree, branch, mode, state FROM run').get() as {
      task_id: string;
      worktree: string | null;
      branch: string | null;
      mode: string;
      state: string;
    };
    expect(run).toEqual({
      task_id: 'I_migration0001',
      worktree: null,
      branch: null,
      mode: 'research',
      state: 'queued',
    });
  });

  it('still rejects a task that is not specnode · pin · idea', () => {
    const db = migrated().database;
    expect(() =>
      db.prepare(
        `INSERT INTO run(id,task_id,agent,mode,state)
         VALUES('R_migration0002','S_migration0001','researcher','research','queued')`,
      ).run(),
    ).toThrowError(/run_task_must_be_specnode_pin_or_idea/);
  });

  it('keeps the state machine: unknown states and unended done both fail', () => {
    const db = migrated().database;
    expect(() =>
      db.prepare(
        `INSERT INTO run(id,task_id,agent,mode,state)
         VALUES('R_migration0003','I_migration0001','researcher','research','paused')`,
      ).run(),
    ).toThrowError(/CHECK/);
    expect(() =>
      db.prepare(
        `INSERT INTO run(id,task_id,agent,mode,state)
         VALUES('R_migration0004','I_migration0001','researcher','research','done')`,
      ).run(),
    ).toThrowError(/CHECK/);
  });

  it('keeps a research run loggable and checkpointable without a git_ref', () => {
    const db = migrated().database;
    db.prepare(
      `INSERT INTO run(id,task_id,agent,mode,state,started_at)
       VALUES('R_migration0005','I_migration0001','researcher','research','needs_input','${AT}')`,
    ).run();
    db.prepare(
      `INSERT INTO run_log(run_id,seq,at,stream,line)
       VALUES('R_migration0005',1,'${AT}','event','{"type":"run.wait","question":"예산을 얼마로?"}')`,
    ).run();
    db.prepare(
      `INSERT INTO checkpoint(id,run_id,seq,git_ref,summary,created_at)
       VALUES('C_migration0001','R_migration0005',1,NULL,'멀티턴 3턴째 대기 상태','${AT}')`,
    ).run();
    const checkpoint = db.prepare('SELECT git_ref, summary FROM checkpoint').get() as {
      git_ref: string | null;
      summary: string;
    };
    expect(checkpoint).toEqual({ git_ref: null, summary: '멀티턴 3턴째 대기 상태' });
  });

  it("activates thread kind 'agent' on a migrated file", () => {
    const db = migrated().database;
    db.prepare(
      `INSERT INTO thread(id,kind,last_seq,created_at)
       VALUES('agent:R_migration0001','agent',0,'${AT}')`,
    ).run();
    const thread = db.prepare(`SELECT kind FROM thread WHERE id = 'agent:R_migration0001'`).get() as {
      kind: string;
    };
    expect(thread.kind).toBe('agent');
  });
});

describe('v17 — two devices across the migration boundary', () => {
  it('lets device B open the file device A migrated, and both records survive', async () => {
    applyV14(file);
    seedV14(file);

    const a = open({ deviceId: 'devA' });
    expect(a.schema.actual).toBe(17);
    a.database
      .prepare(
        `INSERT INTO event(thread_id,type,payload,at,device_id,uuid)
         VALUES('project:PRJ_migration01','idea.captured','{"ideaId":"I_migration0001"}','${AT}','devA','u-dev-a')`,
      )
      .run();
    await a.close();

    const b = open({ deviceId: 'devB' });
    expect(b.schema.actual).toBe(17);
    expect(b.schema.created).toBe(false);
    const events = b.database
      .prepare('SELECT device_id, uuid FROM event ORDER BY seq')
      .all() as Array<{ device_id: string | null; uuid: string | null }>;
    expect(events).toEqual([
      { device_id: null, uuid: null }, // the v14 seed row, untouched
      { device_id: 'devA', uuid: 'u-dev-a' },
    ]);
    // B writes too — the (device_id, seq) identity keeps both worlds apart.
    b.database
      .prepare(
        `INSERT INTO event(thread_id,type,payload,at,device_id,uuid)
         VALUES('project:PRJ_migration01','idea.listed','{}','${AT}','devB','u-dev-b')`,
      )
      .run();
    expect(b.database.prepare('SELECT count(*) c FROM event').get()).toMatchObject({ c: 3 });
  });
});

describe('v17 — run data never crosses the bundle boundary (A5)', () => {
  it('readProject carries no run rows even with runs on disk', async () => {
    applyV14(file);
    seedV14(file);
    const store = open();
    const db = store.database;
    seedIdea(db);
    db.prepare(
      `INSERT INTO run(id,task_id,agent,mode,state)
       VALUES('R_bundle0000001','I_migration0001','researcher','research','queued')`,
    ).run();

    const project = await store.readProject('PRJ_migration01');
    const exported = JSON.stringify(project);
    expect(exported).not.toContain('R_bundle0000001');
    expect(exported).not.toContain('"run"');
  });
});
