import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Pin, Screen } from '@spec-studio/protocol';
import { hasFts5, openSqliteStore, splitSchema, type SqliteStore } from '../src';

/** The v14 canon DDL, frozen as a fixture: this is what a real v14 file looks like. */
const FIXTURE = fileURLToPath(new URL('./fixtures/schema-v14.sql', import.meta.url));

const AT = '2026-11-19T09:00:00.000Z';

const SCREEN: Screen = {
  id: `S_${'c'.repeat(12)}`,
  title: '주문 상세',
  code: 'SCR-110',
  ref: {
    kind: 'image',
    value: 'data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E',
    label: '샘플 화면',
  },
  figmaUrl: null,
  viewport: { width: 1200, height: 800 },
  createdAt: AT,
  updatedAt: AT,
};

function pinDraft(pinType: Pin['type'], title: string): {
  type: 'pin.create';
  screenId: string;
  pinType: Pin['type'];
  title: string;
  body: string;
  anchor: { x: number; y: number };
} {
  return { type: 'pin.create', screenId: SCREEN.id, pinType, title, body: '본문', anchor: { x: 0.5, y: 0.4 } };
}

let dir = '';
let file = '';
let clock = 0;
const stores: SqliteStore[] = [];

function tick(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 10, 19, 9, 0, clock)).toISOString();
}

function open(options: { deviceId?: string; actor?: string } = {}): SqliteStore {
  const store = openSqliteStore({ file, clock: tick, ...options });
  stores.push(store);
  return store;
}

/** Applies the v14 fixture the way `applySchema` would (FTS5 is a build option). */
function applyV14(path: string): void {
  const raw = new DatabaseSync(path);
  const { core, search } = splitSchema(readFileSync(FIXTURE, 'utf8'));
  raw.exec(core);
  if (hasFts5(raw)) raw.exec(search);
  raw.close();
}

/** One real-shaped v14 project: screen + pin + requirement, a doc with two blocks. */
function seedV14(path: string): void {
  const raw = new DatabaseSync(path);
  raw.exec(`
    INSERT INTO project(id,name,created_at,updated_at)
      VALUES('PRJ_migration01','주문 상세 기획','${AT}','${AT}');
    INSERT INTO obj(id,project_id,kind,subtype,title,parent_id,props,state,rev,hash,created_at,updated_at)
      VALUES('S_migration0001','PRJ_migration01','screen',NULL,'주문 상세',NULL,
             '{"code":"SCR-110","ref":{"kind":"image","value":"data:image/svg+xml;charset=utf-8,%3Csvg%3E","label":"샘플 화면"},"figmaUrl":null,"viewport":{"width":1200,"height":800},"pinSeq":1}',
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
    INSERT INTO block(id,doc_id,parent_id,idx,type,text,attrs,hash,state,created_at,updated_at)
      VALUES('B_migration0002','D_migration0001',NULL,'000001','paragraph',
             '취소 버튼은 재고 상태를 본다.','{"pinRefs":[]}','h-b2','live','${AT}','${AT}');
    INSERT INTO link(id,type,src,dst,created_at)
      VALUES('L_migration0001','implements','P_migration0001','N_migration0001','${AT}');
    INSERT INTO op_log(at,actor,kind,target,before,after,payload)
      VALUES('${AT}','person:owner','pin.create','P_migration0001',NULL,'{}','{}');
    INSERT INTO thread(id,kind,last_seq,created_at)
      VALUES('project:PRJ_migration01','project',1,'${AT}');
    INSERT INTO event(thread_id,type,payload,at)
      VALUES('project:PRJ_migration01','pin.created','{"pinId":"P_migration0001"}','${AT}');
  `);
  raw.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spec-studio-migrate-'));
  file = join(dir, 'graph.db');
  clock = 0;
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('v14 → v15 migration', () => {
  it('moves a real v14 file forward without losing a row', async () => {
    applyV14(file);
    seedV14(file);

    const store = open();
    expect(store.schema.actual).toBe(15);
    expect(store.schema.created).toBe(false);

    const db = store.database;
    const count = (sql: string): number => {
      const row = db.prepare(sql).get() as { c: number | bigint } | undefined;
      return Number(row?.c ?? 0);
    };
    expect(count('SELECT count(*) c FROM obj')).toBe(3);
    expect(count('SELECT count(*) c FROM doc')).toBe(1);
    expect(count('SELECT count(*) c FROM block')).toBe(2);
    expect(count('SELECT count(*) c FROM link')).toBe(1);
    expect(count('SELECT count(*) c FROM op_log')).toBe(1);
    expect(count('SELECT count(*) c FROM event')).toBe(1);

    // Columns v15 adds; past rows keep the NULL the spec promised.
    const doc = db.prepare('SELECT kind, deleted_at FROM doc').get() as {
      kind: string;
      deleted_at: string | null;
    };
    expect(doc.kind).toBe('spec');
    expect(doc.deleted_at).toBeNull();
    const opDevice = db.prepare('SELECT device_id FROM op_log').get() as {
      device_id: string | null;
    };
    expect(opDevice.device_id).toBeNull();
    const eventDevice = db.prepare('SELECT device_id FROM event').get() as {
      device_id: string | null;
    };
    expect(eventDevice.device_id).toBeNull();

    // Opening the file is what issues the device id — exactly one row, kept from now on.
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'device_id'").get() as {
      value: string;
    };
    expect(meta.value).toBe(store.deviceId);
    expect(count("SELECT count(*) c FROM meta WHERE key = 'device_id'")).toBe(1);

    const project = await store.readProject('PRJ_migration01');
    expect(project).toMatchObject({
      id: 'PRJ_migration01',
      name: '주문 상세 기획',
      screen: { id: 'S_migration0001', code: 'SCR-110' },
      pins: [{ id: 'P_migration0001', number: 1, type: 'policy' }],
      doc: {
        id: 'D_migration0001',
        rev: 2,
        blocks: [{ id: 'B_migration0001' }, { id: 'B_migration0002' }],
      },
      graph: {
        nodes: [{ id: 'N_migration0001', type: 'req' }],
        links: [{ id: 'L_migration0001', type: 'implements' }],
      },
    });
  });

  it('stamps every new op_log/event row with the writing device', async () => {
    const a = open({ deviceId: 'dev-test-a' });
    const project = await a.createProject({ name: '주문 상세 기획' });
    await a.execute(project.id, { type: 'screen.attach', screen: SCREEN });
    await a.execute(project.id, pinDraft('policy', '취소 정책'));
    await a.close();
    stores.length = 0;

    const b = open({ deviceId: 'dev-test-b' });
    await b.execute(project.id, pinDraft('exception', '재고 없음 안내'));
    await b.close();
    stores.length = 0;

    const raw = new DatabaseSync(file);
    const opRows = raw.prepare('SELECT device_id FROM op_log ORDER BY seq').all() as Array<{
      device_id: string | null;
    }>;
    const eventRows = raw.prepare('SELECT device_id, uuid FROM event ORDER BY seq').all() as Array<{
      device_id: string | null;
      uuid: string | null;
    }>;
    expect(opRows.map((row) => row.device_id)).toEqual(['dev-test-a', 'dev-test-a', 'dev-test-b']);
    // execute마다 op_log 1행, event는 커맨드가 만큼; 어느 쪽이든 그 행을 쓴
    // 디바이스가 찍혀 있어야 한다 (기록률 100%).
    const eventDevices = eventRows.map((row) => row.device_id);
    expect(eventDevices.every((id) => id === 'dev-test-a' || id === 'dev-test-b')).toBe(true);
    expect(eventDevices.at(-1)).toBe('dev-test-b');
    expect(eventDevices.slice(0, -1).every((id) => id === 'dev-test-a')).toBe(true);
    // 기록률 100%: uuid도 빠짐없이.
    expect(eventRows.every((row) => typeof row.uuid === 'string' && row.uuid.length > 0)).toBe(true);

    const index = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'event_device_seq'")
      .get() as { name: string } | undefined;
    expect(index?.name).toBe('event_device_seq');
    const duplicates = raw
      .prepare('SELECT count(*) c FROM (SELECT device_id, seq FROM event GROUP BY 1, 2 HAVING count(*) > 1)')
      .get() as { c: number | bigint };
    expect(Number(duplicates.c)).toBe(0);
    raw.close();
  });

  it('issues the device id once into meta and reads it back on reopen', async () => {
    const first = open();
    const issued = first.deviceId;
    expect(issued).toMatch(/^dev_[a-z0-9]+$/);
    const project = await first.createProject({ name: '주문 상세 기획' });
    await first.execute(project.id, { type: 'screen.attach', screen: SCREEN });
    const stamped = first.database
      .prepare('SELECT device_id FROM op_log ORDER BY seq DESC LIMIT 1')
      .get() as { device_id: string | null };
    expect(stamped.device_id).toBe(issued);
    await first.close();
    stores.length = 0;

    const second = open();
    expect(second.deviceId).toBe(issued);
    const meta = second.database
      .prepare("SELECT count(*) c FROM meta WHERE key = 'device_id'")
      .get() as { c: number | bigint };
    expect(Number(meta.c)).toBe(1);
  });

  it('names the ledger actor the call gives, else the store default', async () => {
    const store = open({ actor: 'person:crew' });
    const project = await store.createProject({ name: '주문 상세 기획' });
    await store.execute(project.id, { type: 'screen.attach', screen: SCREEN });
    await store.execute(project.id, pinDraft('policy', '취소 정책'), { actor: 'person:tester' });
    await store.execute(project.id, pinDraft('function', '취소 요청 버튼'));

    const actors = (
      store.database.prepare('SELECT actor FROM op_log ORDER BY seq').all() as Array<{ actor: string }>
    ).map((row) => row.actor);
    expect(actors).toEqual(['person:crew', 'person:tester', 'person:crew']);
  });
});
