import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Pin, Screen } from '@spec-studio/protocol';
import { openSqliteStore, type SqliteStore } from '../src';

const SCREEN: Screen = {
  id: `S_${'c'.repeat(12)}`,
  title: '주문 상세',
  code: 'SCR-110',
  ref: {
    kind: 'image',
    value: 'data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E',
    label: '샘플 화면',
  },
  figmaUrl: null,
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
  dir = mkdtempSync(join(tmpdir(), 'spec-studio-store-'));
  file = join(dir, 'graph.db');
  clock = 0;
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seed(store: SqliteStore): Promise<string> {
  const project = await store.createProject({ name: '주문 상세 기획', id: 'PRJ_abcdefghijkl' });
  await store.execute(project.id, { type: 'screen.attach', screen: SCREEN });
  const drafts = [
    { pinType: 'function' as const, title: '취소 요청 버튼', body: '배송 준비 중일 때만 활성', anchor: { x: 0.18, y: 0.28 } },
    { pinType: 'policy' as const, title: '배송 시작 후 취소 불가', body: '사전조건: 배송 시작', anchor: { x: 0.5, y: 0.4 } },
    { pinType: 'exception' as const, title: '재고 없음 안내', body: '', anchor: { x: 0.78, y: 0.62 } },
  ];
  for (const draft of drafts) {
    await store.execute(project.id, {
      type: 'pin.create',
      screenId: SCREEN.id,
      pinType: draft.pinType,
      title: draft.title,
      body: draft.body,
      anchor: draft.anchor,
    });
  }
  return project.id;
}

describe('the schema', () => {
  it('creates itself on an empty file and reports the promised version', () => {
    const store = open();
    expect(store.schema.created).toBe(true);
    expect(store.schema.actual).toBe(15);
  });

  it('does not re-create tables when the file already carries them', async () => {
    const first = open();
    await seed(first);
    await first.close();
    stores.length = 0;

    const second = open();
    expect(second.schema.created).toBe(false);
    expect(await second.readProject('PRJ_abcdefghijkl')).not.toBeNull();
  });
});

describe('round trip through real SQLite', () => {
  it('writes a project, a screen and three pins, and reads the same state back', async () => {
    const store = open();
    const projectId = await seed(store);
    const project = await store.readProject(projectId);

    expect(project?.name).toBe('주문 상세 기획');
    expect(project?.screen).toEqual(SCREEN);
    expect(project?.pins.map((pin) => pin.number)).toEqual([1, 2, 3]);
    expect(project?.pins.map((pin) => pin.type)).toEqual(['function', 'policy', 'exception']);
    expect(project?.pins[1]?.anchor).toEqual({ x: 0.5, y: 0.4 });
    expect(project?.pinSeq).toBe(3);

    const rows = store.database
      .prepare("SELECT kind, count(*) AS n FROM obj GROUP BY kind ORDER BY kind")
      .all() as Array<{ kind: string; n: number }>;
    expect(rows).toEqual([
      { kind: 'pin', n: 3 },
      { kind: 'screen', n: 1 },
    ]);
  });

  it('keeps the screen under the project it belongs to', async () => {
    const store = open();
    await seed(store);
    const row = store.database
      .prepare("SELECT project_id, state FROM obj WHERE id = ?")
      .get(SCREEN.id) as { project_id: string; state: string };
    expect(row.project_id).toBe('PRJ_abcdefghijkl');
    expect(row.state).toBe('linked');
  });

  it('survives a reopen: the file, not the process, holds the project', async () => {
    const first = open();
    const projectId = await seed(first);
    await first.close();
    stores.length = 0;

    const second = open();
    const project = await second.readProject(projectId);
    expect(project?.pins).toHaveLength(3);
    expect(project?.pins[2]?.title).toBe('재고 없음 안내');
  });

  it('lists the projects the file holds', async () => {
    const store = open();
    expect(await store.listProjectIds()).toEqual([]);
    await store.createProject({ name: 'A', id: 'PRJ_a' });
    await store.createProject({ name: 'B', id: 'PRJ_b' });
    expect(await store.listProjectIds()).toEqual(['PRJ_a', 'PRJ_b']);
  });

  it('returns null for a project that is not there', async () => {
    expect(await open().readProject('PRJ_missing')).toBeNull();
  });
});

describe('numbers stay put', () => {
  it('edits a pin without changing its number', async () => {
    const store = open();
    const projectId = await seed(store);
    const before = (await store.readProject(projectId))?.pins[0] as Pin;

    await store.execute(projectId, {
      type: 'pin.update',
      screenId: SCREEN.id,
      pinId: before.id,
      pinType: 'policy',
      title: '취소 요청 — 데스크에서만',
      body: '모바일은 숨김',
    });

    const after = (await store.readProject(projectId))?.pins.find((pin) => pin.id === before.id);
    expect(after).toMatchObject({
      number: 1,
      type: 'policy',
      title: '취소 요청 — 데스크에서만',
      body: '모바일은 숨김',
    });
  });

  it('moves a pin without changing its number', async () => {
    const store = open();
    const projectId = await seed(store);
    const before = (await store.readProject(projectId))?.pins[1] as Pin;

    const outcome = await store.execute(projectId, {
      type: 'pin.update',
      screenId: SCREEN.id,
      pinId: before.id,
      anchor: { x: 0.11, y: 0.92 },
    });

    const after = outcome.project.pins.find((pin) => pin.id === before.id);
    expect(after?.number).toBe(2);
    expect(after?.anchor).toEqual({ x: 0.11, y: 0.92 });
    expect(outcome.events.map((event) => event.type)).toEqual(['pin.updated']);
  });

  it('leaves a tombstone for a deleted pin and gives the next one #4', async () => {
    const store = open();
    const projectId = await seed(store);
    const middle = (await store.readProject(projectId))?.pins[1] as Pin;

    await store.execute(projectId, {
      type: 'pin.delete',
      screenId: SCREEN.id,
      pinId: middle.id,
    });
    const created = await store.execute(projectId, {
      type: 'pin.create',
      screenId: SCREEN.id,
      pinType: 'function',
      title: '새 핀',
      body: '',
      anchor: { x: 0.3, y: 0.3 },
    });

    expect(created.project.pins.map((pin) => pin.number)).toEqual([1, 3, 4]);
    expect(created.project.pinSeq).toBe(4);

    const tombstone = store.database
      .prepare('SELECT deleted_at, props, title FROM obj WHERE id = ?')
      .get(middle.id) as { deleted_at: string | null; props: string; title: string };
    expect(tombstone.deleted_at).not.toBeNull();
    expect(tombstone.title).toBe(middle.title);
    expect((JSON.parse(tombstone.props) as { number: number }).number).toBe(2);
  });

  it('keeps the high-water mark across a reopen, gap included', async () => {
    const first = open();
    const projectId = await seed(first);
    const middle = (await first.readProject(projectId))?.pins[1] as Pin;
    await first.execute(projectId, { type: 'pin.delete', screenId: SCREEN.id, pinId: middle.id });
    await first.close();
    stores.length = 0;

    const second = open();
    const project = await second.readProject(projectId);
    expect(project?.pinSeq).toBe(3);
    expect(project?.pins.map((pin) => pin.number)).toEqual([1, 3]);

    const created = await second.execute(projectId, {
      type: 'pin.create',
      screenId: SCREEN.id,
      pinType: 'exception',
      title: '재시도 실패',
      body: '',
      anchor: { x: 0.9, y: 0.9 },
    });
    expect(created.project.pins.at(-1)?.number).toBe(4);
  });

  it('starts a new numbering space when the screen is replaced', async () => {
    const store = open();
    const projectId = await seed(store);

    const replacement = await store.execute(projectId, {
      type: 'screen.attach',
      screen: { ...SCREEN, id: `S_${'d'.repeat(12)}`, title: '주문 목록', code: 'SCR-111' },
    });
    expect(replacement.project.pins).toEqual([]);
    expect(replacement.project.pinSeq).toBe(0);

    const created = await store.execute(projectId, {
      type: 'pin.create',
      screenId: `S_${'d'.repeat(12)}`,
      pinType: 'function',
      title: '첫 핀',
      body: '',
      anchor: { x: 0.5, y: 0.5 },
    });
    expect(created.project.pins[0]?.number).toBe(1);

    const old = store.database
      .prepare("SELECT count(*) AS n FROM obj WHERE kind = 'screen' AND deleted_at IS NOT NULL")
      .get() as { n: number };
    expect(old.n).toBe(1);
  });
});

describe('the write path', () => {
  it('records one event row per command and advances the thread cursor', async () => {
    const store = open();
    const projectId = await seed(store);

    const thread = store.database
      .prepare('SELECT id, last_seq FROM thread WHERE id = ?')
      .get(`project:${projectId}`) as { id: string; last_seq: number };
    expect(thread.id).toBe(`project:${projectId}`);
    expect(thread.last_seq).toBe(5);

    const events = store.database
      .prepare('SELECT type FROM event ORDER BY seq')
      .all() as Array<{ type: string }>;
    expect(events.map((event) => event.type)).toEqual([
      'screen.attached',
      'doc.attached',
      'pin.created',
      'pin.created',
      'pin.created',
    ]);

    const logs = store.database
      .prepare('SELECT kind FROM op_log ORDER BY seq')
      .all() as Array<{ kind: string }>;
    expect(logs.map((log) => log.kind)).toEqual([
      'screen.attach',
      'pin.create',
      'pin.create',
      'pin.create',
    ]);
  });

  it('records each package export as an event and an op row with the file list', async () => {
    const store = open();
    const projectId = await seed(store);
    const files = ['spec-summary.md', 'tasks.md', 'bundle.json'];

    const stampedAt = (store.database
      .prepare('SELECT updated_at FROM project WHERE id = ?')
      .get(projectId) as { updated_at: string }).updated_at;

    const outcome = await store.execute(projectId, { type: 'project.package.export', files });
    expect(outcome.events.map((event) => event.type)).toEqual(['package.exported']);
    await store.execute(projectId, { type: 'project.package.export', files });

    // An export is a read — it must not touch the project's updated_at, or a
    // second export of the same state would differ from the first (AC-8).
    expect(
      (store.database.prepare('SELECT updated_at FROM project WHERE id = ?').get(projectId) as {
        updated_at: string;
      }).updated_at,
    ).toBe(stampedAt);

    const rows = store.database
      .prepare("SELECT kind, payload, device_id FROM op_log WHERE kind = 'package.export' ORDER BY seq")
      .all() as Array<{ kind: string; payload: string | null; device_id: string | null }>;
    // one row per export — a re-export is history, not a deduplicated write
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]!.payload ?? '{}').files).toEqual(files);
    expect(rows.every((row) => row.device_id !== null && row.device_id !== '')).toBe(true);

    const events = store.database
      .prepare("SELECT type, device_id FROM event WHERE type = 'package.exported'")
      .all() as Array<{ type: string; device_id: string | null }>;
    expect(events).toHaveLength(2);
    expect(events.every((row) => row.device_id !== null && row.device_id !== '')).toBe(true);
  });

  it('writes nothing when the command is rejected', async () => {
    const store = open();
    const projectId = await seed(store);
    const before = await store.readProject(projectId);

    await expect(
      store.execute(projectId, {
        type: 'pin.create',
        screenId: SCREEN.id,
        pinType: 'function',
        title: '   ',
        body: '',
        anchor: { x: 0.1, y: 0.1 },
      }),
    ).rejects.toThrow();

    const after = await store.readProject(projectId);
    expect(after?.pins).toHaveLength(before?.pins.length ?? 0);
    const events = store.database
      .prepare('SELECT count(*) AS n FROM event')
      .get() as {
      n: number;
    };
    expect(events.n).toBe(5);
  });

  it('refuses a command for a project the file does not hold', async () => {
    const store = open();
    await expect(
      store.execute('PRJ_missing', {
        type: 'pin.delete',
        screenId: SCREEN.id,
        pinId: `P_${'a'.repeat(12)}`,
      }),
    ).rejects.toThrow(/no project/);
  });
});
