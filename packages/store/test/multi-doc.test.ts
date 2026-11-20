import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project, Screen } from '@spec-studio/protocol';
import { remapProject } from '@spec-studio/core';
import { openSqliteStore, type SqliteStore } from '../src';

/**
 * W3/F5 through the only writer: a project owns a registry of documents
 * (`docs`), each with a kind, ordered by birth. Deletion is a tombstone the
 * file keeps — and the ledger can put back.
 */

const SCREEN: Screen = {
  id: `S_${'m'.repeat(12)}`,
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
  return new Date(Date.UTC(2026, 10, 19, 11, 0, clock)).toISOString();
}

function open(): SqliteStore {
  const store = openSqliteStore({ file, clock: tick });
  stores.push(store);
  return store;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spec-studio-multidoc-'));
  file = join(dir, 'graph.db');
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A project with its auto spec doc, two pins and one linked paragraph. */
async function seeded(store: SqliteStore): Promise<string> {
  const project = await store.createProject({ name: '주문 상세 기획', id: 'PRJ_multidoc0001' });
  await store.execute(project.id, { type: 'screen.attach', screen: SCREEN });
  await store.execute(project.id, {
    type: 'pin.create',
    screenId: SCREEN.id,
    pinType: 'function',
    title: '취소 요청',
    body: '배송 준비 중일 때만 활성',
    anchor: { x: 0.2, y: 0.3 },
  });
  const docId = (await store.readProject(project.id))?.docs[0]?.id as string;
  await store.execute(project.id, {
    type: 'doc.block.create',
    docId,
    blockType: 'paragraph',
    text: '배송이 시작되기 전까지만 취소할 수 있다.',
  });
  return project.id;
}

describe('the document registry in SQLite', () => {
  it('keeps every doc with its kind, in birth order, across a reload', async () => {
    const store = open();
    const projectId = await seeded(store);
    await store.execute(projectId, { type: 'doc.create', title: '리서치 노트', kind: 'research' });
    await store.execute(projectId, { type: 'doc.create', title: '스펙 B', kind: 'spec' });

    const reloaded = (await store.readProject(projectId)) as Project;
    expect(reloaded.docs.map((doc) => [doc.title, doc.kind])).toEqual([
      ['주문 상세 문서', 'spec'],
      ['리서치 노트', 'research'],
      ['스펙 B', 'spec'],
    ]);

    await store.close();
    stores.length = 0;
    const second = open();
    const reopened = (await second.readProject(projectId)) as Project;
    expect(reopened.docs.map((doc) => doc.id)).toEqual(reloaded.docs.map((doc) => doc.id));
  });

  it('writes a block only into the doc the command names', async () => {
    const store = open();
    const projectId = await seeded(store);
    const research = await store.execute(projectId, {
      type: 'doc.create',
      title: '리서치 노트',
      kind: 'research',
    });
    const researchId = research.project.docs[1]?.id as string;

    const created = await store.execute(projectId, {
      type: 'doc.block.create',
      docId: researchId,
      blockType: 'paragraph',
      text: '경쟁 서비스는 취소가 하루만 가능했다.',
    });
    expect(created.project.docs[0]?.blocks).toHaveLength(1);
    expect(created.project.docs[1]?.blocks).toHaveLength(1);

    const reloaded = (await store.readProject(projectId)) as Project;
    expect(reloaded.docs[0]?.blocks.map((block) => block.text)).toEqual([
      '배송이 시작되기 전까지만 취소할 수 있다.',
    ]);
    expect(reloaded.docs[1]?.blocks.map((block) => block.text)).toEqual([
      '경쟁 서비스는 취소가 하루만 가능했다.',
    ]);
  });

  it('renames a doc, deletes it softly, and refuses blocks on the tombstone', async () => {
    const store = open();
    const projectId = await seeded(store);
    const created = await store.execute(projectId, {
      type: 'doc.create',
      title: '리서치 노트',
      kind: 'spec',
    });
    const researchId = created.project.docs[1]?.id as string;

    const renamed = await store.execute(projectId, {
      type: 'doc.update',
      docId: researchId,
      title: '조사 메모',
    });
    expect(renamed.project.docs[1]?.title).toBe('조사 메모');

    const deleted = await store.execute(projectId, { type: 'doc.delete', docId: researchId });
    expect(deleted.project.docs).toHaveLength(1);
    // the row stays, tombstoned — the file, not memory, says so
    const row = store.database
      .prepare('SELECT title, deleted_at FROM doc WHERE id = ?')
      .get(researchId) as { title: string; deleted_at: string };
    expect(row.title).toBe('조사 메모');
    expect(row.deleted_at).not.toBeNull();

    await expect(
      store.execute(projectId, {
        type: 'doc.block.create',
        docId: researchId,
        blockType: 'paragraph',
        text: '삭제된 문서에는 쓸 수 없다',
      }),
    ).rejects.toThrow(/문서가 없습니다/);
  });

  it('closes the proposal a deleted doc still had on the table', async () => {
    const store = open();
    const projectId = await seeded(store);
    const docId = (await store.readProject(projectId))?.docs[0]?.id as string;
    await store.execute(projectId, { type: 'proposal.create', docId });
    const deleted = await store.execute(projectId, { type: 'doc.delete', docId });
    expect(deleted.project.proposal?.state).toBe('rejected');
    expect(deleted.project.proposal?.decidedAt).not.toBeNull();
  });

  it('puts a deleted doc and its blocks back through the ledger', async () => {
    const store = open();
    const projectId = await seeded(store);
    const docId = (await store.readProject(projectId))?.docs[0]?.id as string;

    const deleted = await store.execute(projectId, { type: 'doc.delete', docId });
    expect(deleted.project.docs).toHaveLength(0);
    const revertable = store.lastRevertable(projectId);
    expect(revertable).toMatchObject({ kind: 'doc', blocks: 1 });
    expect(revertable?.summary).toContain('주문 상세 문서');

    const reverted = await store.revert(projectId);
    expect(reverted.revertedSeq).toBe(deleted.opSeq);
    expect(reverted.project.docs[0]?.blocks.map((block) => block.text)).toEqual([
      '배송이 시작되기 전까지만 취소할 수 있다.',
    ]);
    expect(store.lastRevertable(projectId)).toBeNull();

    // the undo row marks the deletion, so a second undo of it refuses
    await expect(store.revert(projectId, deleted.opSeq)).rejects.toThrow(/찾지 못했습니다/);

    // ...and the resurrection survives a reopen: the file says so
    await store.close();
    stores.length = 0;
    const second = open();
    const reopened = (await second.readProject(projectId)) as Project;
    expect(reopened.docs).toHaveLength(1);
    expect(reopened.docs[0]?.blocks[0]?.text).toBe('배송이 시작되기 전까지만 취소할 수 있다.');
    const rows = second.database
      .prepare("SELECT state, count(*) AS n FROM block GROUP BY state")
      .all() as Array<{ state: string; n: number }>;
    expect(rows).toEqual([{ state: 'live', n: 1 }]);
  });
  it('carries two docs with their blocks through an export→import remap', async () => {
    const store = open();
    const projectId = await seeded(store);
    const research = await store.execute(projectId, {
      type: 'doc.create',
      title: '리서치 노트',
      kind: 'research',
    });
    const researchId = research.project.docs[1]?.id as string;
    await store.execute(projectId, {
      type: 'doc.block.create',
      docId: researchId,
      blockType: 'paragraph',
      text: '경쟁 서비스는 취소가 하루만 가능했다.',
    });

    const source = (await store.readProject(projectId)) as Project;
    expect(source.docs).toHaveLength(2);
    const imported = await store.importProject(remapProject(source, (kind) => store.nextId(kind)));
    expect(imported.id).not.toBe(source.id);

    const copy = (await store.readProject(imported.id)) as Project;
    expect(copy.docs).toHaveLength(2);
    expect(copy.docs.map((doc) => [doc.title, doc.kind])).toEqual([
      ['주문 상세 문서', 'spec'],
      ['리서치 노트', 'research'],
    ]);
    // every id is new, no block landed twice, and the text came along
    const sourceIds = new Set([
      ...source.docs.map((doc) => doc.id),
      ...source.docs.flatMap((doc) => doc.blocks.map((block) => block.id)),
    ]);
    for (const doc of copy.docs) {
      expect(sourceIds.has(doc.id)).toBe(false);
      for (const block of doc.blocks) expect(sourceIds.has(block.id)).toBe(false);
    }
    expect(copy.docs.flatMap((doc) => doc.blocks.map((block) => block.text))).toEqual([
      '배송이 시작되기 전까지만 취소할 수 있다.',
      '경쟁 서비스는 취소가 하루만 가능했다.',
    ]);
  });
});
