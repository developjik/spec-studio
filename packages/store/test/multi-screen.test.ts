import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { Command, Screen } from '@spec-studio/protocol';
import { remapProject } from '@spec-studio/core';
import { openSqliteStore, splitSchema } from '../src';

const at = '2026-11-19T09:00:00.000Z';
const screen = (n: number): Screen => ({
  id: `S_${String(n).padStart(12, '0')}`,
  title: `화면 ${n}`,
  code: `SCR-${100 + n}`,
  ref: { kind: 'route', value: `/${n}` },
  viewport: { width: 1280, height: 800 },
  createdAt: at,
  updatedAt: at,
});
const pin = (n: number): Command => ({
  type: 'pin.create',
  screenId: screen(n).id,
  pinType: 'function',
  title: '버튼',
  body: '',
  anchor: { x: 0.5, y: 0.5 },
});

describe('multi-screen SQLite persistence', () => {
  it('keeps independent gaps, order, active screen, docs and import references across reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'screens-'));
    const file = join(dir, 'db');
    let store = openSqliteStore({ file });
    try {
      const id = (await store.createProject({ name: '다중 화면' })).id;
      for (let n = 1; n <= 3; n++) {
        await store.execute(id, { type: 'screen.add', screen: screen(n) });
        await store.execute(id, pin(n));
        await store.execute(id, pin(n));
      }
      let project = (await store.readProject(id))!;
      expect(project.pins.map((p) => p.number)).toEqual([1, 1, 1, 2, 2, 2]);
      const removed = project.pins.find((p) => p.screenId === screen(1).id && p.number === 2)!;
      await store.execute(id, {
        type: 'screen.select',
        screenId: screen(1).id,
      });
      await store.execute(id, {
        type: 'pin.delete',
        screenId: screen(1).id,
        pinId: removed.id,
      });
      await store.execute(id, pin(1));
      await store.execute(id, {
        type: 'screen.reorder',
        screenIds: [screen(3).id, screen(1).id, screen(2).id],
      });
      await store.close();
      store = openSqliteStore({ file });
      project = (await store.readProject(id))!;
      expect(project.screens?.map((s) => s.id)).toEqual([screen(3).id, screen(1).id, screen(2).id]);
      expect(project.activeScreenId).toBe(screen(1).id);
      expect(project.pinSeq).toBe(3);
      expect(project.pins.filter((p) => p.screenId === screen(1).id).map((p) => p.number)).toEqual([
        1, 3,
      ]);
      expect(project.docs.map((d) => d.screenId)).toEqual([
        screen(1).id,
        screen(2).id,
        screen(3).id,
      ]);
      const count = store.database
        .prepare("SELECT count(*) n FROM obj WHERE kind='screen' AND deleted_at IS NULL")
        .get();
      expect(count?.n).toBe(3);
      let seq = 0;
      const copy = remapProject(project, (kind) => `${kind}_${++seq}`);
      expect(new Set(copy.screens?.map((s) => s.id)).size).toBe(3);
      expect(copy.pins.every((p) => copy.screens?.some((s) => s.id === p.screenId))).toBe(true);
      expect(copy.docs.every((d) => copy.screens?.some((s) => s.id === d.screenId))).toBe(true);
      expect(copy.screenPinSeq?.[copy.activeScreenId!]).toBe(3);
      await store.execute(id, {
        type: 'screen.delete',
        screenId: screen(1).id,
      });
      project = (await store.readProject(id))!;
      expect(project.screen?.id).toBe(screen(3).id);
      expect(project.pins).toHaveLength(4);
      expect(project.docs).toHaveLength(2);
      expect(project.pins.some((p) => p.screenId === screen(1).id)).toBe(false);
      expect(
        (await store.execute(id, pin(3))).project.pins
          .filter((p) => p.screenId === screen(3).id)
          .map((p) => p.number),
      ).toEqual([1, 2, 3]);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates a real v15 one-screen file without losing its pin counter or document', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'screens-v15-'));
    const file = join(dir, 'db');
    const raw = new DatabaseSync(file);
    raw.exec(
      splitSchema(readFileSync(new URL('./fixtures/schema-v15.sql', import.meta.url), 'utf8')).core,
    );
    raw
      .prepare('INSERT INTO project(id,name,created_at,updated_at) VALUES(?,?,?,?)')
      .run('PRJ_000000000001', '구버전', at, at);
    raw
      .prepare(
        'INSERT INTO obj(id,project_id,kind,state,title,props,hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        screen(1).id,
        'PRJ_000000000001',
        'screen',
        'linked',
        '화면 1',
        JSON.stringify({ ...screen(1), pinSeq: 7 }),
        'legacy-hash',
        at,
        at,
      );
    raw
      .prepare(
        'INSERT INTO doc(id,project_id,screen_id,title,rev,kind,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run('D_000000000001', 'PRJ_000000000001', screen(1).id, '설계서', 4, 'spec', at, at);
    raw.close();
    const store = openSqliteStore({ file });
    try {
      const project = (await store.readProject('PRJ_000000000001'))!;
      expect(store.schema.actual).toBe(17);
      expect(project.screens).toHaveLength(1);
      expect(project.activeScreenId).toBe(screen(1).id);
      expect(project.pinSeq).toBe(7);
      expect(project.docs[0]).toMatchObject({
        id: 'D_000000000001',
        screenId: screen(1).id,
        rev: 4,
      });
      expect((await store.execute(project.id, pin(1))).project.pins[0]?.number).toBe(8);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
