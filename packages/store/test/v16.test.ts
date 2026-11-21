import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Screen } from '@spec-studio/protocol';
import { hasFts5, openSqliteStore, splitSchema, type SqliteStore } from '../src';

/** The v14 canon DDL, frozen as a fixture: this is what a real v14 file looks like. */
const FIXTURE = fileURLToPath(new URL('./fixtures/schema-v14.sql', import.meta.url));
/** The v11 canon DDL (git a9bb35f), frozen: real files that migrated since W2 carry it. */
const FIXTURE_V11 = fileURLToPath(new URL('./fixtures/schema-v11.sql', import.meta.url));

const AT = '2026-11-19T09:00:00.000Z';

const SCREEN: Screen = {
  id: `S_${'c'.repeat(12)}`,
  title: '주문 상세',
  code: 'SCR-110',
  ref: {
    kind: 'image',
    value: 'data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E',
    label: '샘플 화면',
  },
  figmaUrl: null,
  viewport: { width: 1200, height: 800 },
  createdAt: AT,
  updatedAt: AT,
};

let dir = '';
let file = '';
let clock = 0;
const stores: SqliteStore[] = [];

function tick(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 10, 19, 9, 0, clock)).toISOString();
}

function open(): SqliteStore {
  const store = openSqliteStore({ file, clock: tick });
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

function applyV11(path: string): void {
  const raw = new DatabaseSync(path);
  const { core, search } = splitSchema(readFileSync(FIXTURE_V11, 'utf8'));
  raw.exec(core);
  if (hasFts5(raw)) raw.exec(search);
  raw.close();
}

/**
 * One real-shaped v11 project. doc has only its four original columns — the
 * project/screen/kind/tombstone ones arrive later by ALTER, appended at the
 * end. That appended order is exactly what a positional `SELECT *` got wrong
 * in 15→16 (검증자 Blocker 1).
 */
function seedV11(path: string): void {
  const raw = new DatabaseSync(path);
  raw.exec(`
    INSERT INTO project(id,name,created_at,updated_at)
      VALUES('PRJ_migrated11','주문 상세 기획','${AT}','${AT}');
    INSERT INTO obj(id,project_id,kind,subtype,title,parent_id,props,state,rev,hash,created_at,updated_at)
      VALUES('S_migrated001','PRJ_migrated11','screen',NULL,'주문 상세',NULL,
             '{"code":"SCR-110","ref":{"kind":"image","value":"data:image/svg+xml;charset=utf-8,%3Csvg%3E","label":"샘플 화면"},"figmaUrl":null,"viewport":{"width":1200,"height":800},"pinSeq":1}',
             'linked',1,'h-screen','${AT}','${AT}');
    INSERT INTO obj(id,project_id,kind,subtype,title,parent_id,props,state,rev,hash,created_at,updated_at)
      VALUES('P_migrated001','PRJ_migrated11','pin','policy','배송 시작 후 취소 불가','S_migrated001',
             '{"number":1,"body":"배송 시작 전에만 취소 가능","anchor":{"x":0.5,"y":0.4}}',
             'open',1,'h-pin','${AT}','${AT}');
    INSERT INTO obj(id,project_id,kind,subtype,title,parent_id,props,state,rev,hash,created_at,updated_at)
      VALUES('N_migrated001','PRJ_migrated11','specnode','requirement','취소 요청',NULL,
             '{"body":"배송 전 취소 요청을 받는다"}','draft',1,'h-req','${AT}','${AT}');
    INSERT INTO doc(id,title,rev,created_at)
      VALUES('D_migrated001','주문 상세 문서',2,'${AT}');
    INSERT INTO block(id,doc_id,parent_id,idx,type,text,attrs,hash,state)
      VALUES('B_migrated001','D_migrated001',NULL,'000000','paragraph',
             '배송이 시작되기 전까지만 취소할 수 있다.','{"pinRefs":[]}','h-b1','live');
    INSERT INTO link(id,type,src,dst,created_at)
      VALUES('L_migrated001','expresses','N_migrated001','S_migrated001','${AT}');
    INSERT INTO proposal(id,doc_id,origin,summary,base_rev,author_kind,risk,state,created_at)
      VALUES('PR_migrated001','D_migrated001','pin','취소 문장을 좁힌다',2,'ai','low','open','${AT}');
    INSERT INTO proposal_op(id,proposal_id,seq,kind,target_block,view,state)
      VALUES('op_migrated001','PR_migrated001',1,'insert','B_migrated001',
             '{"blockId":"B_migrated001","afterBlockId":null,"before":null,"after":{"type":"paragraph","text":"추가","pinRefs":[]}}','open');
    INSERT INTO thread(id,kind,last_seq,created_at)
      VALUES('project:PRJ_migrated11','project',0,'${AT}');
    INSERT INTO event(thread_id,type,payload,at)
      VALUES('project:PRJ_migrated11','pin.created','{"pinId":"P_migrated001"}','${AT}');
    INSERT INTO op_log(at,actor,kind,target,before,after,payload)
      VALUES('${AT}','person:owner','pin.create','P_migrated001',NULL,'{}','{}');
  `);
  raw.close();
}

/** One real-shaped v14 project — plus a proposal row, whose idea_id must be NULL after the chain. */
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spec-studio-v16-'));
  file = join(dir, 'graph.db');
  clock = 0;
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('v14 → v15 → v16 migration chain', () => {
  it('moves a real v14 file to 16 without losing a row', async () => {
    applyV14(file);
    seedV14(file);

    const store = open();
    expect(store.schema.actual).toBe(16);
    expect(store.schema.created).toBe(false);

    const db = store.database;
    const count = (sql: string): number => {
      const row = db.prepare(sql).get() as { c: number | bigint } | undefined;
      return Number(row?.c ?? 0);
    };
    expect(count('SELECT count(*) c FROM obj')).toBe(3);
    expect(count('SELECT count(*) c FROM doc')).toBe(1);
    expect(count('SELECT count(*) c FROM block')).toBe(1);
    expect(count('SELECT count(*) c FROM link')).toBe(1);
    expect(count('SELECT count(*) c FROM proposal')).toBe(1);
    expect(count('SELECT count(*) c FROM op_log')).toBe(1);
    expect(count('SELECT count(*) c FROM event')).toBe(1);

    // proposal.idea_id is v16's column; a v14 row never named an idea.
    const columns = (db.prepare('PRAGMA table_info(proposal)').all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    expect(columns).toContain('idea_id');
    const proposal = db.prepare('SELECT idea_id FROM proposal').get() as {
      idea_id: string | null;
    };
    expect(proposal.idea_id).toBeNull();

    // The rebuilt doc table kept kind and the tombstone column from v15.
    const doc = db.prepare('SELECT kind, deleted_at FROM doc').get() as {
      kind: string;
      deleted_at: string | null;
    };
    expect(doc.kind).toBe('spec');
    expect(doc.deleted_at).toBeNull();

    const project = await store.readProject('PRJ_migration01');
    expect(project).toMatchObject({
      id: 'PRJ_migration01',
      docs: [{ id: 'D_migration0001', kind: 'spec', rev: 2 }],
      proposals: [{ id: 'PR_migration0001', ideaId: null }],
      graph: { nodes: [{ id: 'N_migration0001' }] },
    });
  });
});

describe('v11-origin migrated file → v16 (검증자 Blocker 1 회귀)', () => {
  // A file that *migrated* since v11 has its doc columns in appended order —
  // (id,title,rev,created_at,project_id,screen_id,updated_at,kind,deleted_at) —
  // not the canonical order a fresh CREATE writes. A positional SELECT * in
  // migrate-15-16 pushed NULL project_id into NOT NULL rev and the file died
  // at user_version 15. This fixture is the real v11 DDL from git a9bb35f.
  it('migrates a real v11 file all the way to 16 without losing a row', async () => {
    applyV11(file);
    seedV11(file);

    const store = open();
    expect(store.schema.actual).toBe(16);
    expect(store.schema.created).toBe(false);

    const db = store.database;
    const count = (sql: string): number => {
      const row = db.prepare(sql).get() as { c: number | bigint } | undefined;
      return Number(row?.c ?? 0);
    };
    expect(count('SELECT count(*) c FROM obj')).toBe(3);
    expect(count('SELECT count(*) c FROM doc')).toBe(1);
    expect(count('SELECT count(*) c FROM block')).toBe(1);
    expect(count('SELECT count(*) c FROM link')).toBe(1);
    expect(count('SELECT count(*) c FROM proposal')).toBe(1);
    expect(count('SELECT count(*) c FROM proposal_op')).toBe(1);
    expect(count('SELECT count(*) c FROM op_log')).toBe(1);
    expect(count('SELECT count(*) c FROM event')).toBe(1);

    // The row crossed the doc rebuild with every column landing in the right
    // place — title stays a title, rev stays a number, nothing moved.
    const doc = db.prepare('SELECT title, rev, kind, deleted_at FROM doc').get() as {
      title: string;
      rev: number;
      kind: string;
      deleted_at: string | null;
    };
    expect(doc).toEqual({
      title: '주문 상세 문서',
      rev: 2,
      kind: 'spec',
      deleted_at: null,
    });
    const proposal = db.prepare('SELECT summary, idea_id FROM proposal').get() as {
      summary: string;
      idea_id: string | null;
    };
    expect(proposal.summary).toBe('취소 문장을 좁힌다');
    expect(proposal.idea_id).toBeNull();

    // Minor 2: the rebuilt doc's delete behaviour must match the canonical
    // DDL (CASCADE / SET NULL), not drift to RESTRICT/RESTRICT.
    const fks = db.prepare('PRAGMA foreign_key_list(doc)').all() as Array<{
      table: string;
      on_delete: string;
    }>;
    const onDelete = new Map(fks.map((fk) => [fk.table, fk.on_delete]));
    expect(onDelete.get('project')).toBe('CASCADE');
    expect(onDelete.get('obj')).toBe('SET NULL');

    // The v11 doc predates doc.project_id, so it stays outside this project's
    // doc list — the row-level checks above carry the preservation proof.
    const project = await store.readProject('PRJ_migrated11');
    expect(project).toMatchObject({
      id: 'PRJ_migrated11',
      graph: { nodes: [{ id: 'N_migrated001' }], links: [{ id: 'L_migrated001' }] },
    });
  });
});

describe('v16 — doc kind and proposal idea', () => {
  it('accepts a backlog document and round-trips it', async () => {
    const store = open();
    const project = await store.createProject({ name: '주문 상세 기획' });
    const outcome = await store.execute(project.id, {
      type: 'doc.create',
      title: '릴리스 백로그',
      kind: 'backlog',
    });
    const created = outcome.events.find((event) => event.type === 'doc.created');
    expect(created?.type).toBe('doc.created');

    const read = await store.readProject(project.id);
    expect(read?.docs.map((doc) => doc.kind)).toEqual(['backlog']);
  });

  it('persists proposal.ideaId through a close/reopen (MN-A)', async () => {
    const store = open();
    const project = await store.createProject({ name: '주문 상세 기획' });
    await store.execute(project.id, {
      type: 'idea.capture',
      text: '정기결제 카드 실패 재시도',
    });
    await store.execute(project.id, { type: 'doc.create', title: '리서치', kind: 'research' });
    let read = await store.readProject(project.id);
    const idea = read?.ideas[0];
    const research = read?.docs[0];
    expect(idea).toBeDefined();
    expect(research?.kind).toBe('research');

    await store.execute(project.id, {
      type: 'proposal.create',
      docId: research!.id,
      draft: {
        title: '재시도 브리프',
        summary: '실패 결제는 3회 재시도한다',
        claims: [{ text: '3회 재시도가 표준', evidenceRefs: [], ungrounded: true }],
      },
      source: 'rule',
      ideaId: idea!.id,
    });

    read = await store.readProject(project.id);
    expect(read?.proposals[0]?.ideaId).toBe(idea!.id);

    // The link must survive the thing that used to erase it: a restart.
    await store.close();
    stores.length = 0;
    const reopened = open();
    read = await reopened.readProject(project.id);
    expect(read?.proposals[0]?.ideaId).toBe(idea!.id);
  });

  it('keeps event.type a free string — journey.* needs no schema enum', async () => {
    const store = open();
    const project = await store.createProject({ name: '주문 상세 기획' });
    await store.execute(project.id, { type: 'screen.attach', screen: SCREEN });

    // An event kind nobody has heard of inserts as-is: the column is TEXT
    // with no CHECK, so any future journey.* kind stays recordable.
    store.database
      .prepare('INSERT INTO event(thread_id,type,payload,at) VALUES(?,?,?,?)')
      .run(`project:${project.id}`, 'journey.future-kind', '{}', tick());
    const row = store.database
      .prepare('SELECT type FROM event WHERE type = ?')
      .get('journey.future-kind') as { type: string } | undefined;
    expect(row?.type).toBe('journey.future-kind');
  });
});

describe('v16 — journey marks (AC-1/F0-6)', () => {
  it('stamps one journey.mark per milestone, timed off event timestamps', async () => {
    const store = open();
    const project = await store.createProject({ name: '주문 상세 기획' });

    await store.execute(project.id, { type: 'screen.attach', screen: SCREEN });
    await store.execute(project.id, { type: 'idea.capture', text: '재시도 아이디어' });
    await store.execute(project.id, { type: 'doc.create', title: '리서치', kind: 'research' });

    let read = await store.readProject(project.id);
    const idea = read!.ideas[0]!;
    const research = read!.docs.find((doc) => doc.kind === 'research')!;

    const filed = await store.execute(project.id, {
      type: 'proposal.create',
      docId: research.id,
      draft: {
        title: '브리프',
        summary: '요약',
        claims: [{ text: '주장', evidenceRefs: [], ungrounded: true }],
      },
      source: 'rule',
      ideaId: idea.id,
    });
    const proposal = filed.project.proposals.find((row) => row.docId === research.id)!;
    await store.execute(project.id, {
      type: 'proposal.adopt',
      docId: research.id,
      proposalId: proposal.id,
    });
    await store.execute(project.id, { type: 'idea.update', ideaId: idea.id, state: 'promoted' });
    await store.execute(project.id, {
      type: 'project.package.export',
      files: ['bundle.json'],
    });

    const marks = store.database
      .prepare(
        `SELECT type, payload, at FROM event
          WHERE thread_id = ? AND type = 'journey.mark' ORDER BY seq`,
      )
      .all(`project:${project.id}`) as Array<{ type: string; payload: string; at: string }>;

    const stages = marks.map((row) => (JSON.parse(row.payload) as { stage: string }).stage);
    expect(stages).toEqual(['attach', 'capture', 'brief', 'promote', 'package']);

    // Every mark carries a non-negative elapsed measured off the previous
    // mark's timestamp — the report reads durations straight from the ledger.
    const elapsed = marks.map((row) => (JSON.parse(row.payload) as { elapsedMs: number }).elapsedMs);
    expect(elapsed.every((ms) => Number.isFinite(ms) && ms >= 0)).toBe(true);
    // The clock ticks once per execute, so marks after the first carry a gap.
    expect(elapsed.slice(1).every((ms) => ms > 0)).toBe(true);

    // A doc-adoption on a *spec* doc must not masquerade as the brief stage:
    // marks only count the milestones above.
    await store.execute(project.id, { type: 'doc.create', title: '스펙', kind: 'spec' });
    read = await store.readProject(project.id);
    const specDoc = read!.docs.find((doc) => doc.kind === 'spec')!;
    await store.execute(project.id, {
      type: 'pin.create',
      screenId: SCREEN.id,
      pinType: 'policy',
      title: '취소 정책',
      body: '배송 전만 취소',
      anchor: { x: 0.5, y: 0.4 },
    });
    const specFiled = await store.execute(project.id, { type: 'proposal.create', docId: specDoc.id });
    const specProposal = specFiled.project.proposals.find((row) => row.docId === specDoc.id)!;
    await store.execute(project.id, {
      type: 'proposal.adopt',
      docId: specDoc.id,
      proposalId: specProposal.id,
    });
    const markCount = (
      store.database
        .prepare("SELECT count(*) c FROM event WHERE thread_id = ? AND type = 'journey.mark'")
        .get(`project:${project.id}`) as { c: number | bigint }
    ).c;
    expect(Number(markCount)).toBe(5);
  });
});
