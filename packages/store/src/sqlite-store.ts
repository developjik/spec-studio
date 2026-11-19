import type { DatabaseSync } from 'node:sqlite';
import { DatabaseSync as Database } from 'node:sqlite';
import { normalizeProject, execute as applyCommand } from '@spec-studio/core';
import type { Command, DomainEvent, Project, Screen } from '@spec-studio/protocol';
import {
  newPinId,
  newProjectId,
  newScreenId,
  pinToRow,
  projectFromRows,
  screenToRow,
  type ObjRow,
} from './mapping';
import { applySchema, transaction, type SchemaInfo } from './schema';
import {
  findLatestPublish,
  findPublishBySpec,
  listPublishRecords,
  savePublishRecord,
  type PublishRecord,
  type PublishRecordInput,
} from './publish-record';
import type { ExecuteOutcome, StorePort } from './index';

export interface SqliteStoreOptions {
  /** A file path, or `:memory:` for tests. */
  file: string;
  schemaPath?: string;
  /** Supplied so tests get deterministic timestamps; the port itself has no clock rule. */
  clock?: () => string;
  newId?: (kind: 'project' | 'screen' | 'pin') => string;
}

interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

/** `node:sqlite` types rows as `Record<string, SQLOutputValue>`; this is the one place we assert. */
function oneRow<T>(db: DatabaseSync, sql: string, ...params: Array<string | number>): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

function allRows<T>(db: DatabaseSync, sql: string, ...params: Array<string | number>): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

const DEFAULT_IDS = { project: newProjectId, screen: newScreenId, pin: newPinId } as const;

/**
 * The single writer, finally backed by a database instead of `localStorage`.
 *
 * Every command goes through `@spec-studio/core` first — that is where the
 * numbering rule lives — and the resulting state is written in one
 * transaction. Deletions are tombstones (`deleted_at`), never `DELETE`, so the
 * number a deleted pin was given stays visible in the file it once lived in.
 */
export class SqliteStore implements StorePort {
  readonly #db: DatabaseSync;
  readonly #clock: () => string;
  readonly #newId: (kind: 'project' | 'screen' | 'pin') => string;
  readonly #schema: SchemaInfo;
  #closed = false;

  private constructor(options: SqliteStoreOptions) {
    this.#db = new Database(options.file);
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#newId = options.newId ?? ((kind) => DEFAULT_IDS[kind]());
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#schema = applySchema(this.#db, options.schemaPath);
  }

  static open(options: SqliteStoreOptions): SqliteStore {
    return new SqliteStore(options);
  }

  get schema(): SchemaInfo {
    return this.#schema;
  }

  /** Escape hatch for the adapter's own tests; not part of `StorePort`. */
  get database(): DatabaseSync {
    return this.#db;
  }

  async createProject(input: { name: string; id?: string; at?: string }): Promise<Project> {
    const at = input.at ?? this.#clock();
    const name = input.name.trim();
    if (name === '') throw new Error('a project needs a name');
    const id = input.id ?? this.#newId('project');

    transaction(this.#db, () => {
      this.#db
        .prepare('INSERT INTO project(id,name,created_at,updated_at) VALUES(?,?,?,?)')
        .run(id, name, at, at);
      this.#db
        .prepare("INSERT OR IGNORE INTO thread(id,kind,last_seq,created_at) VALUES(?,'project',0,?)")
        .run(this.#threadId(id), at);
    });

    return {
      version: 1,
      id,
      name,
      screen: null,
      pins: [],
      pinSeq: 0,
      createdAt: at,
      updatedAt: at,
    };
  }

  async readProject(projectId: string): Promise<Project | null> {
    const row = oneRow<ProjectRow>(
      this.#db,
      'SELECT id,name,created_at,updated_at FROM project WHERE id = ?',
      projectId,
    );
    if (row === undefined) return null;

    const screen =
      oneRow<ObjRow>(
        this.#db,
        "SELECT * FROM obj WHERE project_id = ? AND kind = 'screen' AND deleted_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
        projectId,
      ) ?? null;

    const pins =
      screen === null
        ? []
        : allRows<ObjRow>(
            this.#db,
            "SELECT * FROM obj WHERE project_id = ? AND kind = 'pin' AND deleted_at IS NULL AND parent_id = ? ORDER BY CAST(json_extract(props,'$.number') AS INTEGER)",
            projectId,
            screen.id,
          );

    return normalizeProject(
      projectFromRows({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        screen,
        pins,
      }),
    );
  }

  async listProjectIds(): Promise<string[]> {
    const rows = allRows<{ id: string }>(this.#db, 'SELECT id FROM project ORDER BY created_at, rowid');
    return rows.map((row) => row.id);
  }

  async execute(projectId: string, command: Command): Promise<ExecuteOutcome> {
    const before = await this.readProject(projectId);
    if (before === null) throw new Error(`no project ${projectId} in this database`);

    const at = this.#clock();
    const result = applyCommand(before, command, {
      at,
      nextId: (kind) => (kind === 'screen' ? this.#newId('screen') : this.#newId('pin')),
    });
    const after: Project = { ...result.project, updatedAt: at };

    const seq = transaction(this.#db, () => {
      this.#writeProject(before, after, at);
      this.#appendEvents(projectId, result.events, at);
      this.#appendLog(before, after, command, result.events, at);
      return this.#lastSeq(projectId);
    });

    return { project: after, seq, events: result.events };
  }

  /** Newest publish records first — the modal's history list. */
  listPublishes(projectId: string, limit = 20): PublishRecord[] {
    return listPublishRecords(this.#db, projectId, limit);
  }

  /** A successful publish of exactly this spec to this target, if one exists. */
  findPublishBySpec(input: {
    projectId: string;
    target: 'confluence';
    spaceKey: string;
    specHash: string;
  }): PublishRecord | null {
    return findPublishBySpec(this.#db, input);
  }

  /** The last page this project published to a target — the update target. */
  findLatestPublish(input: {
    projectId: string;
    target: 'confluence';
    spaceKey: string;
  }): PublishRecord | null {
    return findLatestPublish(this.#db, input);
  }

  savePublish(input: PublishRecordInput): PublishRecord {
    return savePublishRecord(this.#db, input);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #threadId(projectId: string): string {
    return `project:${projectId}`;
  }

  #lastSeq(projectId: string): number {
    const row = oneRow<{ last_seq?: number }>(
      this.#db,
      'SELECT last_seq FROM thread WHERE id = ?',
      this.#threadId(projectId),
    );
    return Number(row?.last_seq ?? 0);
  }

  #appendEvents(projectId: string, events: readonly DomainEvent[], at: string): void {
    if (events.length === 0) return;
    const threadId = this.#threadId(projectId);
    this.#db
      .prepare("INSERT OR IGNORE INTO thread(id,kind,last_seq,created_at) VALUES(?,'project',0,?)")
      .run(threadId, at);
    const insert = this.#db.prepare(
      'INSERT INTO event(thread_id,type,payload,at) VALUES(?,?,?,?)',
    );
    for (const event of events) insert.run(threadId, event.type, JSON.stringify(event), at);
  }

  #appendLog(
    before: Project,
    after: Project,
    command: Command,
    events: readonly DomainEvent[],
    at: string,
  ): void {
    const created = events.find(
      (event): event is Extract<DomainEvent, { type: 'pin.created' }> =>
        event.type === 'pin.created',
    );
    const target =
      created?.pin.id ?? ('pinId' in command ? command.pinId : (after.screen?.id ?? null));

    this.#db
      .prepare(
        'INSERT INTO op_log(at,actor,kind,target,before,after,payload) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        at,
        'person:owner',
        command.type,
        target,
        JSON.stringify(objectOf(before, target)),
        JSON.stringify(objectOf(after, target)),
        JSON.stringify({ events: events.map((event) => event.type) }),
      );
  }

  #writeProject(before: Project | null, project: Project, at: string): void {
    const upsertProject = this.#db.prepare(
      'INSERT INTO project(id,name,created_at,updated_at) VALUES(?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at',
    );
    upsertProject.run(project.id, project.name, project.createdAt, project.updatedAt);

    const previousScreen = before?.screen ?? null;
    if (project.screen !== null) {
      this.#upsertObj(screenToRow(project.screen, project.id), { pinSeq: project.pinSeq });
      if (previousScreen !== null && previousScreen.id !== project.screen.id) {
        this.#tombstoneScreen(previousScreen, at);
      }
    }

    for (const pin of project.pins) {
      this.#upsertObj(pinToRow(pin, project.id));
    }

    const kept = new Set(project.pins.map((pin) => pin.id));
    for (const old of before?.pins ?? []) {
      if (!kept.has(old.id)) this.#tombstone(old.id, at);
    }
  }

  /** Upserts one `obj` row; `pinSeq` rides along in a screen's props. */
  #upsertObj(row: ObjRow, extra?: { pinSeq: number }): void {
    const props =
      extra === undefined
        ? row.props
        : JSON.stringify({ ...(JSON.parse(row.props) as Record<string, unknown>), pinSeq: extra.pinSeq });

    this.#db
      .prepare(
        `INSERT INTO obj (id, project_id, kind, subtype, title, parent_id, props, state, rev, hash, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           subtype    = excluded.subtype,
           title      = excluded.title,
           parent_id  = excluded.parent_id,
           props      = excluded.props,
           state      = excluded.state,
           rev        = obj.rev + (CASE WHEN obj.hash <> excluded.hash OR obj.props <> excluded.props THEN 1 ELSE 0 END),
           hash       = excluded.hash,
           deleted_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.id,
        row.project_id,
        row.kind,
        row.subtype,
        row.title,
        row.parent_id,
        props,
        row.state,
        row.rev,
        row.hash,
        row.deleted_at,
        row.created_at,
        row.updated_at,
      );
  }

  #tombstoneScreen(screen: Screen, at: string): void {
    this.#tombstone(screen.id, at);
    const pins = allRows<{ id: string }>(
      this.#db,
      "SELECT id FROM obj WHERE kind = 'pin' AND parent_id = ? AND deleted_at IS NULL",
      screen.id,
    );
    for (const pin of pins) this.#tombstone(pin.id, at);
  }

  #tombstone(id: string, at: string): void {
    this.#db
      .prepare('UPDATE obj SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(at, at, id);
  }
}

function objectOf(project: Project | null, id: string | null): unknown {
  if (project === null || id === null) return null;
  if (project.screen?.id === id) return project.screen;
  return project.pins.find((pin) => pin.id === id) ?? null;
}

export function openSqliteStore(options: SqliteStoreOptions): SqliteStore {
  return SqliteStore.open(options);
}
