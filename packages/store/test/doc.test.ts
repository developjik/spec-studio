import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Screen } from '@spec-studio/protocol';
import { openSqliteStore, type SqliteStore } from '../src';

/**
 * W4 through the only writer: blocks land in `block`, the adopted proposal in
 * `proposal`/`proposal_op`, and the revert reads `op_log.before` from the file
 * — not from anything the process kept in memory.
 */

const SCREEN: Screen = {
  id: `S_${'c'.repeat(12)}`,
  title: '주문 상세',
  code: 'SCR-110',
  ref: { kind: 'image', value: 'data:image/svg+xml;base64,PHN2Zy8+' },
  viewport: { width: 1200, height: 800 },
  createdAt: '2026-11-19T09:00:00.000Z',
  updatedAt: '2026-11-19T09:00:00.000Z',
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spec-studio-w4-'));
  file = join(dir, 'graph.db');
  clock = 0;
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seeded(store: SqliteStore): Promise<string> {
  const project = await store.createProject({ name: '주문 상세 기획', id: 'PRJ_abcdefghijkl' });
  await store.execute(project.id, { type: 'screen.attach', screen: SCREEN });
  for (const draft of [
    { pinType: 'function' as const, title: '취소 요청', body: '배송 준비 중일 때만 활성', anchor: { x: 0.2, y: 0.3 } },
    { pinType: 'policy' as const, title: '배송 시작 후 취소 불가', body: '사전조건: 배송 시작', anchor: { x: 0.6, y: 0.5 } },
  ]) {
    await store.execute(project.id, {
      type: 'pin.create',
      screenId: SCREEN.id,
      pinType: draft.pinType,
      title: draft.title,
      body: draft.body,
      anchor: draft.anchor,
    });
  }
  const doc = (await store.readProject(project.id))?.docs[0];
  if (doc === null || doc === undefined) throw new Error('the screen did not bring a document');
  const created = await store.execute(project.id, {
    type: 'doc.block.create',
    docId: doc.id,
    blockType: 'paragraph',
    text: '배송이 시작되기 전까지만 취소할 수 있다.',
  });
  const blockId = created.project.docs[0]?.blocks[0]?.id as string;
  const pinId = created.project.pins[0]?.id as string;
  await store.execute(project.id, { type: 'doc.pin.link', docId: doc.id, blockId, pinId });
  return project.id;
}

describe('the document in SQLite', () => {
  it('invalidates queued pin text changes but not anchor moves, and does not rewrite unchanged history', async () => {
    const store = open();
    const projectId = await seeded(store);
    let project = (await store.readProject(projectId))!;
    const docId = project.docs[0]!.id;
    const pinId = project.pins[0]!.id;
    const created = await store.execute(projectId, { type: 'proposal.create', docId });
    const proposalId = created.project.proposals.at(-1)!.id;
    const beforeRows = store.database.prepare('SELECT id FROM proposal_op WHERE proposal_id = ?').all(proposalId);
    await store.execute(projectId, { type: 'pin.update', screenId: SCREEN.id, pinId, anchor: {x:0.4,y:0.4} });
    expect(store.database.prepare('SELECT id FROM proposal_op WHERE proposal_id = ?').all(proposalId)).toEqual(beforeRows);
    await store.execute(projectId, { type: 'proposal.adopt', docId, proposalId });
    const next = await store.execute(projectId, { type: 'proposal.create', docId });
    const nextId = next.project.proposals.at(-1)!.id;
    await store.execute(projectId, { type: 'pin.update', screenId: SCREEN.id, pinId, title: '새 제목' });
    await expect(store.execute(projectId, { type: 'proposal.adopt', docId, proposalId: nextId })).rejects.toThrow(/참조 핀/);
    const refreshed = await store.execute(projectId, { type: 'proposal.create', docId });
    await store.execute(projectId, { type: 'proposal.adopt', docId, proposalId: refreshed.project.proposals.at(-1)!.id });
  });

  it('blocks an insert with a reverted anchor while leaving a fresh insert adoptable', async () => {
    const store = open();
    const projectId = await seeded(store);
    const docId = (await store.readProject(projectId))!.docs[0]!.id;
    const first = await store.execute(projectId, { type: 'proposal.create', docId });
    const adopted = await store.execute(projectId, { type: 'proposal.adopt', docId, proposalId: first.project.proposals.at(-1)!.id });
    const second = await store.execute(projectId, { type: 'proposal.create', docId });
    const secondId = second.project.proposals.at(-1)!.id;
    await store.revert(projectId, adopted.opSeq);
    await expect(store.execute(projectId, { type: 'proposal.adopt', docId, proposalId: secondId })).rejects.toThrow(/변경/);
  });

  it('creates the document with the screen and stores blocks under it', async () => {
    const store = open();
    const projectId = await seeded(store);
    const docRow = store.database
      .prepare('SELECT id, project_id, screen_id, rev, updated_at FROM doc')
      .get() as { id: string; project_id: string; screen_id: string; rev: number; updated_at: string };
    expect(docRow.project_id).toBe(projectId);
    expect(docRow.screen_id).toBe(SCREEN.id);
    expect(docRow.updated_at).not.toBeNull();

    const blockRow = store.database
      .prepare("SELECT idx, type, text, attrs, state FROM block WHERE state = 'live'")
      .get() as { idx: string; type: string; text: string; attrs: string; state: string };
    expect(blockRow.type).toBe('paragraph');
    expect(blockRow.idx).toBe('000000');
    const attrs = JSON.parse(blockRow.attrs) as { pinRefs: Array<{ pinId: string }> };
    expect(attrs.pinRefs).toHaveLength(1);
  });

  it('keeps block order and text across a reopen', async () => {
    const store = open();
    const projectId = await seeded(store);
    const doc = (await store.readProject(projectId))?.docs[0];
    await store.execute(projectId, {
      type: 'doc.block.create',
      docId: doc?.id as string,
      blockType: 'heading',
      text: '취소 정책',
      afterBlockId: null,
    });
    await store.close();
    stores.length = 0;

    const second = open();
    const reopened = (await second.readProject(projectId))?.docs[0];
    expect(reopened?.blocks[0]?.text).toBe('취소 정책');
    expect(reopened?.blocks[1]?.text).toContain('배송이 시작되기 전까지만 취소할 수 있다.');
    expect(reopened?.blocks[1]?.text).toContain('[핀] #1 취소 요청');
    expect(reopened?.blocks[1]?.pinRefs).toHaveLength(1);
  });

  it('round-trips proposal → adopt → op_log.before → revert', async () => {
    const store = open();
    const projectId = await seeded(store);
    const before = await store.readProject(projectId);
    const docId = before?.docs[0]?.id as string;
    const blockId = before?.docs[0]?.blocks[0]?.id as string;
    const pinId = before?.pins[0]?.id as string;
    const originalText = before?.docs[0]?.blocks[0]?.text as string;

    // the pin's spec moves on, which is what makes the paragraph stale
    await store.execute(projectId, {
      type: 'pin.update',
      screenId: SCREEN.id,
      pinId,
      title: '취소 요청 버튼',
    });

    const created = await store.execute(projectId, { type: 'proposal.create', docId });
    const proposal = created.project.proposals[0];
    expect(proposal?.state).toBe('open');
    expect(proposal?.patches).toHaveLength(1);

    const propoRows = store.database
      .prepare('SELECT seq, kind, target_block, new_text FROM proposal_op ORDER BY seq')
      .all() as Array<{ seq: number; kind: string; target_block: string; new_text: string }>;
    expect(propoRows).toHaveLength(1);
    expect(propoRows[0]?.kind).toBe('replace');
    expect(propoRows[0]?.target_block).toBe(blockId);

    const adopted = await store.execute(projectId, {
      type: 'proposal.adopt',
      docId,
      proposalId: proposal?.id as string,
    });
    expect(adopted.project.docs[0]?.blocks[0]?.text).toContain('#1 취소 요청 버튼');
    expect(adopted.project.proposals[0]?.state).toBe('adopted');

    // the undo record is in the file, before anything in memory
    const log = store.database
      .prepare("SELECT seq, kind, target, before FROM op_log WHERE kind = 'proposal.adopt'")
      .get() as { seq: number; kind: string; target: string; before: string };
    expect(log.seq).toBe(adopted.opSeq);
    expect(log.target).toBe(docId);
    const snapshot = JSON.parse(log.before) as {
      docId: string;
      entries: Array<{ blockId: string; existed: boolean; text: string }>;
    };
    expect(snapshot.docId).toBe(docId);
    expect(snapshot.entries[0]).toMatchObject({ blockId, existed: true, text: originalText });

    const revertable = store.lastRevertable(projectId);
    expect(revertable).toMatchObject({ seq: adopted.opSeq, blocks: 1 });

    const reverted = await store.revert(projectId);
    expect(reverted.revertedSeq).toBe(adopted.opSeq);
    expect(reverted.project.docs[0]?.blocks[0]?.text).toBe(originalText);
    expect(reverted.project.proposals[0]?.state).toBe('rejected');
    expect(store.lastRevertable(projectId)).toBeNull();

    // the revert is its own op_log row, so the undo has an undo
    const revertRow = store.database
      .prepare("SELECT before, payload FROM op_log WHERE kind = 'proposal.revert'")
      .get() as { before: string; payload: string };
    expect(JSON.parse(revertRow.payload)).toMatchObject({ revertedSeq: adopted.opSeq });
    expect((JSON.parse(revertRow.before) as { entries: unknown[] }).entries).toHaveLength(1);

    // ...and it survives a reopen: the file says so, not the process.
    await store.close();
    stores.length = 0;
    const second = open();
    const after = await second.readProject(projectId);
    expect(after?.docs[0]?.blocks[0]?.text).toBe(originalText);
    expect(second.lastRevertable(projectId)).toBeNull();
  });

  it('removes a block an adopted insert added, and keeps the rest', async () => {
    const store = open();
    const projectId = await seeded(store);
    const docId = (await store.readProject(projectId))?.docs[0]?.id as string;
    const created = await store.execute(projectId, { type: 'proposal.create', docId });
    expect(created.project.proposals[0]?.patches[0]?.before).toBeNull();

    await store.execute(projectId, {
      type: 'proposal.adopt',
      docId,
      proposalId: created.project.proposals[0]?.id as string,
    });
    const adopted = await store.readProject(projectId);
    expect(adopted?.docs[0]?.blocks).toHaveLength(2);

    const reverted = await store.revert(projectId);
    expect(reverted.project.docs[0]?.blocks).toHaveLength(1);
    const states = store.database
      .prepare('SELECT state, count(*) AS n FROM block GROUP BY state ORDER BY state')
      .all() as Array<{ state: string; n: number }>;
    expect(states).toEqual([
      { state: 'deleted', n: 1 },
      { state: 'live', n: 1 },
    ]);
  });

  it('refuses a second revert of the same adoption', async () => {
    const store = open();
    const projectId = await seeded(store);
    const docId = (await store.readProject(projectId))?.docs[0]?.id as string;
    const created = await store.execute(projectId, { type: 'proposal.create', docId });
    const adopted = await store.execute(projectId, {
      type: 'proposal.adopt',
      docId,
      proposalId: created.project.proposals[0]?.id as string,
    });
    await store.revert(projectId, adopted.opSeq);
    await expect(store.revert(projectId, adopted.opSeq)).rejects.toThrow(/찾지 못했습니다/);
  });

  it('names ledger rows with the schema vocabulary', async () => {
    const store = open();
    const projectId = await seeded(store);
    const docId = (await store.readProject(projectId))?.docs[0]?.id as string;
    const created = await store.execute(projectId, {
      type: 'doc.block.create',
      docId,
      blockType: 'paragraph',
      text: '둘째 문단',
    });
    const blockId = created.project.docs[0]?.blocks[1]?.id as string;
    await store.execute(projectId, { type: 'doc.block.update', docId, blockId, text: '고친 문단' });
    await store.execute(projectId, { type: 'doc.block.delete', docId, blockId });
    const kinds = store.database
      .prepare("SELECT kind FROM op_log WHERE kind LIKE 'block%' ORDER BY seq")
      .all() as Array<{ kind: string }>;
    // seeded() already wrote a block.create and a block.pin.link
    expect(kinds.map((row) => row.kind)).toEqual([
      'block.create',
      'block.pin.link',
      'block.create',
      'block.update',
      'block.delete',
    ]);
    // the constraint the schema promises: a block edit always carries its before
    const nulls = store.database
      .prepare("SELECT count(*) AS n FROM op_log WHERE kind = 'block.update' AND before IS NULL")
      .get() as { n: number };
    expect(nulls.n).toBe(0);
  });

  it('migrates a database that still reports v12', async () => {
    const legacy = open();
    await legacy.close();
    stores.length = 0;

    // Rewind the file to look like v12: no W4 columns, version 12.
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(file);
    raw.exec(`
      DROP INDEX IF EXISTS doc_project;
      ALTER TABLE doc DROP COLUMN project_id;
      ALTER TABLE doc DROP COLUMN screen_id;
      ALTER TABLE doc DROP COLUMN updated_at;
      ALTER TABLE block DROP COLUMN created_at;
      ALTER TABLE block DROP COLUMN updated_at;
      ALTER TABLE proposal DROP COLUMN queued_at;
      ALTER TABLE proposal DROP COLUMN queue_order;
      ALTER TABLE proposal DROP COLUMN source;
      -- v15 additions a real v12 file never had: strip those too, or the
      -- v14 → v15 ALTERs collide with columns that are still there.
      DROP INDEX IF EXISTS event_device_seq;
      DROP TABLE IF EXISTS meta;
      ALTER TABLE doc DROP COLUMN kind;
      ALTER TABLE doc DROP COLUMN deleted_at;
      ALTER TABLE event DROP COLUMN device_id;
      ALTER TABLE event DROP COLUMN uuid;
      ALTER TABLE op_log DROP COLUMN device_id;
      PRAGMA user_version = 12;
    `);
    raw.close();

    const upgraded = open();
    expect(upgraded.schema.actual).toBe(16);
    const columns = upgraded.database
      .prepare('PRAGMA table_info(doc)')
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['project_id', 'screen_id', 'updated_at']),
    );
  });
});
