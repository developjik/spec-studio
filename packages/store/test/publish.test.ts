import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Screen } from '@spec-studio/protocol';
import { applySchema, openSqliteStore, type SqliteStore } from '../src';

const SCREEN: Screen = {
  id: `S_${'f'.repeat(12)}`,
  title: '주문 상세',
  code: 'SCR-110',
  ref: { kind: 'image', value: 'data:image/svg+xml;base64,PHN2Zy8+' },
  figmaUrl: 'https://www.figma.com/file/abc123/Shop?node-id=12-34',
  viewport: { width: 1200, height: 800 },
  createdAt: '2026-11-19T09:00:00.000Z',
  updatedAt: '2026-11-19T09:00:00.000Z',
};

let dir = '';
let file = '';
const stores: SqliteStore[] = [];

function open(): SqliteStore {
  const store = openSqliteStore({ file });
  stores.push(store);
  return store;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spec-studio-publish-'));
  file = join(dir, 'graph.db');
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seed(store: SqliteStore): Promise<string> {
  const project = await store.createProject({ name: '주문 상세 기획' });
  await store.execute(project.id, { type: 'screen.attach', screen: SCREEN });
  await store.execute(project.id, {
    type: 'pin.create',
    screenId: SCREEN.id,
    pinType: 'function',
    title: '취소 요청',
    body: '배송 준비 중일 때만 활성',
    anchor: { x: 0.2, y: 0.4 },
  });
  return project.id;
}

describe('the Figma frame link', () => {
  it('round-trips through the screen and survives a reopen', async () => {
    const first = open();
    const projectId = await seed(first);
    const project = await first.readProject(projectId);
    expect(project?.screen?.figmaUrl).toBe(SCREEN.figmaUrl);

    await first.close();
    stores.length = 0;

    const second = open();
    expect((await second.readProject(projectId))?.screen?.figmaUrl).toBe(SCREEN.figmaUrl);
  });

  it('is editable without touching the pins', async () => {
    const store = open();
    const projectId = await seed(store);
    const next = 'https://www.figma.com/file/zzz999/Shop?node-id=99-1';

    const outcome = await store.execute(projectId, {
      type: 'screen.update',
      screenId: SCREEN.id,
      figmaUrl: next,
    });

    expect(outcome.project.screen?.figmaUrl).toBe(next);
    expect(outcome.project.pins).toHaveLength(1);
    expect(outcome.project.pins[0]?.number).toBe(1);
    expect(outcome.events.map((event) => event.type)).toEqual(['screen.updated']);
  });

  it('can be cleared with null', async () => {
    const store = open();
    const projectId = await seed(store);
    const outcome = await store.execute(projectId, {
      type: 'screen.update',
      screenId: SCREEN.id,
      figmaUrl: null,
    });
    expect(outcome.project.screen?.figmaUrl).toBeNull();
  });
});

describe('publish records', () => {
  const input = (projectId: string, overrides: Partial<Parameters<SqliteStore['savePublish']>[0]> = {}) => ({
    projectId,
    screenId: SCREEN.id,
    target: 'confluence' as const,
    spaceKey: 'SPEC',
    pageId: '42',
    version: 1,
    outputKind: 'bundle' as const,
    status: 'ok' as const,
    specHash: 'hash-one',
    remoteUrl: 'https://example.atlassian.net/wiki/spaces/SPEC/pages/42',
    idemKey: 'SPEC:42:hash-one',
    note: '3 attachments',
    publishedAt: '2026-11-19T09:30:00.000Z',
    at: '2026-11-19T09:30:00.000Z',
    ...overrides,
  });

  it('keeps a record, finds it by spec, and survives a reopen', async () => {
    const first = open();
    const projectId = await seed(first);
    const saved = first.savePublish(input(projectId));
    expect(saved.id).toMatch(/^PB_/);
    await first.close();
    stores.length = 0;

    const second = open();
    const found = second.findPublishBySpec({
      projectId,
      target: 'confluence',
      spaceKey: 'SPEC',
      specHash: 'hash-one',
    });
    expect(found?.pageId).toBe('42');
    expect(found?.status).toBe('ok');
    expect(second.listPublishes(projectId)).toHaveLength(1);
    expect(second.findLatestPublish({ projectId, target: 'confluence', spaceKey: 'SPEC' })?.remoteUrl).toBe(
      'https://example.atlassian.net/wiki/spaces/SPEC/pages/42',
    );
  });

  it('turns an intent row into the ok row with the same idempotency key', async () => {
    const store = open();
    const projectId = await seed(store);
    const intent = store.savePublish(
      input(projectId, {
        status: 'intent',
        pageId: null,
        version: null,
        remoteUrl: null,
        publishedAt: null,
        note: null,
      }),
    );
    const ok = store.savePublish(input(projectId));

    expect(ok.id).toBe(intent.id);
    expect(store.listPublishes(projectId)).toHaveLength(1);
    expect(store.listPublishes(projectId)[0]?.status).toBe('ok');
  });

  it('refuses a second ok row with the same target and idempotency key', async () => {
    const store = open();
    const projectId = await seed(store);
    store.savePublish(input(projectId));
    // Same key, different spec hash: the upsert keeps the idem promise — one row.
    store.savePublish(input(projectId, { specHash: 'hash-two' }));
    expect(store.listPublishes(projectId)).toHaveLength(1);
  });

  it('records a failed attempt without pretending a page exists', async () => {
    const store = open();
    const projectId = await seed(store);
    const failed = store.savePublish(
      input(projectId, {
        status: 'failed',
        pageId: null,
        version: null,
        remoteUrl: null,
        publishedAt: null,
        note: 'Confluence 응답 401',
      }),
    );
    expect(failed.pageId).toBeNull();
    expect(
      store.findPublishBySpec({ projectId, target: 'confluence', spaceKey: 'SPEC', specHash: 'hash-one' }),
    ).toBeNull();
  });

  it('never stores credentials', async () => {
    const store = open();
    const projectId = await seed(store);
    store.savePublish(input(projectId));
    const columns = store.database
      .prepare('PRAGMA table_info(publish_record)')
      .all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    expect(names).not.toContain('api_token');
    expect(names).not.toContain('token');
    expect(names).not.toContain('email');
  });
});

describe('the v11 → v12 migration', () => {
  it('rebuilds a document-only publish_record so a project row fits', () => {
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE project(id TEXT PRIMARY KEY);
      CREATE TABLE obj(
        id         TEXT PRIMARY KEY,
        project_id TEXT,
        kind       TEXT NOT NULL,
        subtype    TEXT,
        title      TEXT NOT NULL,
        parent_id  TEXT,
        props      TEXT NOT NULL DEFAULT '{}',
        state      TEXT NOT NULL,
        rev        INTEGER NOT NULL DEFAULT 1,
        hash       TEXT NOT NULL,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE proposal(id TEXT PRIMARY KEY);
      CREATE TABLE doc(id TEXT PRIMARY KEY);
      CREATE TABLE block(id TEXT PRIMARY KEY);
      CREATE TABLE link_type(
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        src_kinds  TEXT NOT NULL,
        dst_kinds  TEXT NOT NULL,
        suspect_on TEXT NOT NULL DEFAULT '["hash"]',
        v1         INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO link_type(id,name,src_kinds,dst_kinds) VALUES
        ('derived_from','도출된다','["specnode","contract","verification"]',
         '["specnode","contract","verification","pin"]'),
        ('references','참조한다','["screen","pin","specnode","contract","verification"]',
         '["screen","pin","specnode","contract","verification"]');
      CREATE TABLE thread(id TEXT PRIMARY KEY, kind TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE event(seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
        type TEXT NOT NULL, payload TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE op_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
        actor TEXT NOT NULL, kind TEXT NOT NULL, target TEXT, before TEXT, after TEXT,
        payload TEXT NOT NULL DEFAULT '{}', archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE publish_record (
        id             TEXT PRIMARY KEY,
        doc_id         TEXT NOT NULL,
        target         TEXT NOT NULL,
        page_id        TEXT,
        version        INTEGER,
        snapshot_token TEXT,
        output_kind    TEXT NOT NULL,
        artifact       TEXT,
        status         TEXT NOT NULL,
        idem_key       TEXT NOT NULL,
        note           TEXT,
        at             TEXT NOT NULL
      );
      CREATE UNIQUE INDEX publish_idem ON publish_record(target, idem_key);
      INSERT INTO publish_record(id,doc_id,target,page_id,version,output_kind,status,idem_key,at)
        VALUES('PB_000000000001','D_aaaaaaaaaaaa','confluence','123',4,'body','ok','k1','t');
      PRAGMA user_version = 11;
    `);

    const info = applySchema(legacy);
    expect(info.actual).toBe(17);
    expect(info.created).toBe(false);

    const columns = legacy
      .prepare('PRAGMA table_info(publish_record)')
      .all() as Array<{ name: string; notnull: number }>;
    const byName = new Map(columns.map((column) => [column.name, column.notnull]));
    expect(byName.get('project_id')).toBe(0);
    expect(byName.get('doc_id')).toBe(0);
    expect(columns.map((column) => column.name)).toContain('spec_hash');

    const docRow = legacy
      .prepare("SELECT id, doc_id FROM publish_record WHERE idem_key = 'k1'")
      .get() as { id: string; doc_id: string };
    expect(docRow.doc_id).toBe('D_aaaaaaaaaaaa');

    legacy.prepare("INSERT INTO project(id) VALUES('PRJ_000000000001')").run();
    legacy
      .prepare(
        'INSERT INTO publish_record(id,project_id,target,page_id,output_kind,status,spec_hash,idem_key,published_at,at) ' +
          "VALUES('PB_000000000002','PRJ_000000000001','confluence','99','bundle','ok','h','k2','t','t')",
      )
      .run();
    expect(legacy.prepare('SELECT count(*) AS n FROM publish_record').get()).toEqual({ n: 2 });
    legacy.close();
  });
});
