import type { DatabaseSync } from 'node:sqlite';
import { DatabaseSync as Database } from 'node:sqlite';
import {
  DomainError,
  execute as applyCommand,
  normalizeProject,
  restoreSnapshot,
  snapshotForPatches,
} from '@spec-studio/core';
import type {
  Block,
  Command,
  Doc,
  DocSnapshot,
  DomainEvent,
  Project,
  Proposal,
} from '@spec-studio/protocol';
import { DocSnapshotSchema } from '@spec-studio/protocol';
import {
  blockToRow,
  docFromRows,
  newBlockId,
  newDocId,
  newOpId,
  newPinId,
  newProjectId,
  newProposalId,
  newScreenId,
  pinToRow,
  projectFromRows,
  proposalFromRows,
  proposalOpToRow,
  proposalToRow,
  screenToRow,
  type BlockRow,
  type DocRow,
  type ObjRow,
  type ProposalOpRow,
  type ProposalRow,
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
import type { ExecuteOutcome, RevertOutcome, RevertableOp, StorePort } from './index';

export interface SqliteStoreOptions {
  /** A file path, or `:memory:` for tests. */
  file: string;
  schemaPath?: string;
  /** Supplied so tests get deterministic timestamps; the port itself has no clock rule. */
  clock?: () => string;
  newId?: (kind: 'project' | 'screen' | 'pin' | 'doc' | 'block' | 'proposal') => string;
}

interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface OpLogRow {
  seq: number;
  at: string;
  kind: string;
  target: string | null;
  before: string | null;
  after: string | null;
  payload: string;
}

/** `node:sqlite` types rows as `Record<string, SQLOutputValue>`; this is the one place we assert. */
function oneRow<T>(db: DatabaseSync, sql: string, ...params: Array<string | number>): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

function allRows<T>(db: DatabaseSync, sql: string, ...params: Array<string | number>): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

/**
 * The command name is the API; the `op_log` kind is the ledger vocabulary the
 * schema documents (`block.update`, `block.delete`, `proposal.adopt`…). Keeping
 * the two apart is what lets the ledger's CHECK constraints mean something.
 */
const OP_KIND: Readonly<Record<string, string>> = {
  'doc.block.create': 'block.create',
  'doc.block.update': 'block.update',
  'doc.block.delete': 'block.delete',
  'doc.block.move': 'block.move',
  'doc.pin.link': 'block.pin.link',
  'doc.pin.unlink': 'block.pin.unlink',
  'doc.stale.clear': 'block.stale.clear',
};

const DEFAULT_IDS = {
  project: newProjectId,
  screen: newScreenId,
  pin: newPinId,
  doc: newDocId,
  block: newBlockId,
  proposal: newProposalId,
} as const;

/**
 * The single writer, finally backed by a database instead of `localStorage`.
 *
 * Every command goes through `@spec-studio/core` first — that is where the
 * numbering rule lives — and the resulting state is written in one
 * transaction. Deletions are tombstones (`deleted_at`), never `DELETE`, so the
 * number a deleted pin was given stays visible in the file it once lived in.
 *
 * W4 adds the document (`doc`, `block`) and the proposal layer (`proposal`,
 * `proposal_op`). A block's `attrs.pinRefs` says which pins a paragraph stands
 * on and what each pin looked like when the link was made; `op_log.before`
 * keeps a snapshot of the blocks an adopted proposal touched, which is what an
 * undo restores.
 */
export class SqliteStore implements StorePort {
  readonly #db: DatabaseSync;
  readonly #clock: () => string;
  readonly #newId: (kind: 'project' | 'screen' | 'pin' | 'doc' | 'block' | 'proposal') => string;
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
      doc: null,
      proposal: null,
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

    const docRow = oneRow<DocRow>(
      this.#db,
      'SELECT * FROM doc WHERE project_id = ? ORDER BY coalesce(updated_at, created_at) DESC, rowid DESC LIMIT 1',
      projectId,
    );
    const doc = docRow === undefined ? null : docFromRows(docRow, this.#readBlocks(docRow.id));
    const proposal = doc === null ? null : this.#readProposal(doc.id);

    return normalizeProject(
      projectFromRows({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        screen,
        pins,
        doc,
        proposal,
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
      nextId: (kind) => this.#newId(kind),
    });
    const after: Project = { ...result.project, updatedAt: at };

    return transaction(this.#db, () => {
      this.#writeProject(before, after, at);
      this.#appendEvents(projectId, result.events, at);
      const opSeq = this.#appendLog(before, after, command, result.events, at);
      return {
        project: after,
        seq: this.#lastSeq(projectId),
        opSeq,
        events: result.events,
      };
    });
  }

  /**
   * Restores the blocks one adopted proposal touched, using the snapshot the
   * store itself wrote into `op_log.before`. The revert is a write like any
   * other: it appends its own `op_log` row, so the undo has an undo.
   */
  async revert(projectId: string, seq?: number): Promise<RevertOutcome> {
    const project = await this.readProject(projectId);
    if (project === null) throw new Error(`no project ${projectId} in this database`);
    if (project.doc === null) {
      throw new DomainError('doc_missing', '이 프로젝트에는 되돌릴 문서가 없습니다');
    }

    const adopt = this.#findAdoptable(project.doc.id, seq);
    if (adopt === null) {
      throw new DomainError(
        'invalid_input',
        seq === undefined ? '되돌릴 채택 작업이 없습니다' : `채택 기록 ${seq}번을 찾지 못했습니다`,
      );
    }

    const at = this.#clock();
    const snapshot = DocSnapshotSchema.parse(JSON.parse(adopt.before ?? '{}'));
    const currentSnapshot = snapshotOfBlocks(project.doc, snapshot.entries.map((entry) => entry.blockId), project.doc.rev);
    const doc = restoreSnapshot(project.doc, snapshot, at);
    // The decision was undone: the proposal is no longer adopted, and the
    // revert row below is what says it was an undo rather than a refusal.
    const proposal: Proposal | null =
      project.proposal === null || project.proposal.state !== 'adopted'
        ? project.proposal
        : { ...project.proposal, state: 'rejected', decidedAt: at };
    const next: Project = { ...project, doc, proposal, updatedAt: at };

    transaction(this.#db, () => {
      this.#writeProject(project, next, at);
      this.#appendEvents(
        projectId,
        [{ type: 'doc.reverted', docId: doc.id, revertedSeq: adopt.seq, blocks: snapshot.entries.length }],
        at,
      );
      this.#insertLog({
        at,
        kind: 'proposal.revert',
        target: doc.id,
        before: currentSnapshot,
        after: snapshot,
        payload: { revertedSeq: adopt.seq, proposalId: proposal?.id ?? null },
      });
    });

    return {
      project: next,
      revertedSeq: adopt.seq,
      blocks: snapshot.entries.length,
      seq: this.#lastSeq(projectId),
    };
  }

  /** What a revert button would undo, or null when there is nothing to undo. */
  lastRevertable(projectId: string): RevertableOp | null {
    const docRow = oneRow<DocRow>(
      this.#db,
      'SELECT * FROM doc WHERE project_id = ? ORDER BY coalesce(updated_at, created_at) DESC, rowid DESC LIMIT 1',
      projectId,
    );
    if (docRow === undefined) return null;
    const adopt = this.#findAdoptable(docRow.id, undefined);
    if (adopt === null) return null;
    const payload = JSON.parse(adopt.payload) as { summary?: string; proposalId?: string };
    const snapshot = DocSnapshotSchema.safeParse(JSON.parse(adopt.before ?? '{}'));
    return {
      seq: adopt.seq,
      at: adopt.at,
      summary: payload.summary ?? '',
      proposalId: payload.proposalId ?? null,
      blocks: snapshot.success ? snapshot.data.entries.length : 0,
    };
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

  #readBlocks(docId: string): BlockRow[] {
    return allRows<BlockRow>(
      this.#db,
      "SELECT * FROM block WHERE doc_id = ? AND state = 'live' ORDER BY idx, rowid",
      docId,
    );
  }

  #readProposal(docId: string): Proposal | null {
    const row = oneRow<ProposalRow>(
      this.#db,
      'SELECT * FROM proposal WHERE doc_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      docId,
    );
    if (row === undefined) return null;
    const ops = allRows<ProposalOpRow>(
      this.#db,
      'SELECT id, proposal_id, seq, kind, view, state FROM proposal_op WHERE proposal_id = ? ORDER BY seq',
      row.id,
    );
    if (ops.length === 0) return null;
    return proposalFromRows(
      {
        ...row,
        state: row.state === 'reviewing' ? 'open' : row.state,
      },
      ops,
    );
  }

  #findAdoptable(docId: string, seq: number | undefined): OpLogRow | null {
    const adopt =
      seq === undefined
        ? oneRow<OpLogRow>(
            this.#db,
            "SELECT * FROM op_log WHERE kind = 'proposal.adopt' AND target = ? ORDER BY seq DESC LIMIT 1",
            docId,
          )
        : oneRow<OpLogRow>(
            this.#db,
            "SELECT * FROM op_log WHERE kind = 'proposal.adopt' AND target = ? AND seq = ?",
            docId,
            seq,
          );
    if (adopt === undefined) return null;
    const reverted = oneRow<{ seq: number }>(
      this.#db,
      "SELECT seq FROM op_log WHERE kind = 'proposal.revert' AND json_extract(payload,'$.revertedSeq') = ? LIMIT 1",
      adopt.seq,
    );
    return reverted === undefined ? adopt : null;
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

  #insertLog(input: {
    at: string;
    kind: string;
    target: string | null;
    before: unknown;
    after: unknown;
    payload: unknown;
    actor?: string;
  }): number {
    const result = this.#db
      .prepare('INSERT INTO op_log(at,actor,kind,target,before,after,payload) VALUES(?,?,?,?,?,?,?)')
      .run(
        input.at,
        input.actor ?? 'person:owner',
        input.kind,
        input.target,
        JSON.stringify(input.before),
        JSON.stringify(input.after),
        JSON.stringify(input.payload ?? {}),
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * `op_log` is the undo contract: every write names what it changed and keeps
   * the state it replaced. For an adopted proposal that state is a snapshot of
   * the touched blocks, which is exactly what `revert` restores.
   */
  #appendLog(
    before: Project,
    after: Project,
    command: Command,
    events: readonly DomainEvent[],
    at: string,
  ): number {
    if (command.type === 'proposal.adopt') {
      const doc = before.doc;
      const proposal = after.proposal;
      if (doc === null || proposal === null) {
        throw new Error('an adopted proposal needs the document it was built on');
      }
      const beforeSnapshot = snapshotForPatches(doc, proposal.patches);
      const afterSnapshot = snapshotOfBlocks(
        { ...doc, blocks: after.doc?.blocks ?? doc.blocks },
        proposal.patches.map((patch) => patch.blockId),
        after.doc?.rev ?? doc.rev,
      );
      return this.#insertLog({
        at,
        kind: 'proposal.adopt',
        target: doc.id,
        before: beforeSnapshot,
        after: afterSnapshot,
        payload: { proposalId: proposal.id, summary: proposal.summary },
      });
    }

    const kind = OP_KIND[command.type] ?? command.type;
    if (command.type.startsWith('doc.') || command.type.startsWith('proposal.')) {
      const blockId = 'blockId' in command ? command.blockId : null;
      const target = blockId ?? after.doc?.id ?? before.doc?.id ?? null;
      const snapshotBefore = blockId === null ? null : findBlockBefore(before.doc, blockId);
      const snapshotAfter = blockId === null ? null : findBlockBefore(after.doc, blockId);
      return this.#insertLog({
        at,
        kind,
        target,
        before: { block: snapshotBefore },
        after: { block: snapshotAfter },
        payload: { events: events.map((event) => event.type) },
      });
    }

    const created = events.find(
      (event): event is Extract<DomainEvent, { type: 'pin.created' }> =>
        event.type === 'pin.created',
    );
    const target =
      created?.pin.id ?? ('pinId' in command ? command.pinId : (after.screen?.id ?? null));

    return this.#insertLog({
      at,
      kind,
      target,
      before: objectOf(before, target),
      after: objectOf(after, target),
      payload: { events: events.map((event) => event.type) },
    });
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

    if (project.doc !== null) {
      this.#writeDoc(project.doc, project.id, project.screen?.id ?? null, at);
      if (before !== null && before.doc !== null && before.doc.id !== project.doc.id) {
        this.#retireDoc(before.doc, at);
      }
    }

    if (project.proposal !== null) this.#writeProposal(project.proposal);
  }

  /**
   * Writes the document as it stands now: blocks that are gone are tombstoned,
   * the rest take their position again. Positions are rewritten through a
   * temporary `w<id>` value because the sibling index is unique among live
   * blocks — a straight renumber can collide with a row that has not moved yet.
   */
  #writeDoc(doc: Doc, projectId: string, screenId: string | null, at: string): void {
    this.#db
      .prepare(
        `INSERT INTO doc(id, project_id, screen_id, title, rev, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           screen_id  = excluded.screen_id,
           title      = excluded.title,
           rev        = excluded.rev,
           updated_at = excluded.updated_at`,
      )
      .run(doc.id, projectId, screenId, doc.title, doc.rev, doc.createdAt, at);

    const live = allRows<{ id: string }>(
      this.#db,
      "SELECT id FROM block WHERE doc_id = ? AND state = 'live'",
      doc.id,
    );
    const keep = new Set(doc.blocks.map((block) => block.id));
    const removed = live.filter((row) => !keep.has(row.id));
    if (removed.length > 0) {
      const mark = this.#db.prepare(
        "UPDATE block SET state = 'deleted', updated_at = ? WHERE id = ? AND state = 'live'",
      );
      for (const row of removed) mark.run(at, row.id);
    }

    this.#db.prepare("UPDATE block SET idx = 'w' || id WHERE doc_id = ? AND state = 'live'").run(doc.id);

    const upsert = this.#db.prepare(
      `INSERT INTO block (id, doc_id, parent_id, idx, type, text, attrs, hash, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         idx        = excluded.idx,
         type       = excluded.type,
         text       = excluded.text,
         attrs      = excluded.attrs,
         hash       = excluded.hash,
         state      = 'live',
         updated_at = excluded.updated_at`,
    );
    doc.blocks.forEach((block, index) => {
      const row = blockToRow(block, doc.id, index);
      upsert.run(
        row.id,
        row.doc_id,
        row.parent_id,
        row.idx,
        row.type,
        row.text,
        row.attrs,
        row.hash,
        row.created_at ?? at,
        at,
      );
    });
  }

  #retireDoc(doc: Doc, at: string): void {
    this.#db
      .prepare("UPDATE block SET state = 'deleted', updated_at = ? WHERE doc_id = ? AND state = 'live'")
      .run(at, doc.id);
  }

  #writeProposal(proposal: Proposal): void {
    const row = proposalToRow(proposal);
    this.#db
      .prepare(
        `INSERT INTO proposal (id, doc_id, origin, summary, base_rev, author_kind, risk, state, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, 'ai', 'low', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           summary    = excluded.summary,
           state      = excluded.state,
           risk       = excluded.risk,
           decided_at = excluded.decided_at`,
      )
      .run(
        row.id,
        row.doc_id,
        row.origin,
        row.summary,
        row.base_rev,
        row.state,
        row.created_at,
        row.decided_at,
      );

    this.#db.prepare('DELETE FROM proposal_op WHERE proposal_id = ?').run(proposal.id);
    const insert = this.#db.prepare(
      `INSERT INTO proposal_op
         (id, proposal_id, seq, kind, target_block, base_hash, base_text, new_text, view, state, decision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    proposal.patches.forEach((patch, index) => {
      const row = proposalOpToRow(proposal, patch, index + 1, newOpId());
      insert.run(
        row.id,
        row.proposal_id,
        row.seq,
        row.kind,
        patch.before === null ? null : patch.blockId,
        patch.before === null ? null : patch.before.text.slice(0, 64),
        patch.before?.text ?? null,
        patch.after.text,
        row.view,
        row.state,
        patch.before === null ? 'keep' : 'replace',
      );
    });
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

  #tombstoneScreen(screen: { id: string }, at: string): void {
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

function findBlockBefore(doc: Doc | null, blockId: string): Block | null {
  return doc?.blocks.find((block) => block.id === blockId) ?? null;
}

/** Snapshot of the current state of some blocks — the `before` of a revert. */
function snapshotOfBlocks(doc: Doc, blockIds: readonly string[], rev: number): DocSnapshot {
  const entries = blockIds.map((blockId) => {
    const index = doc.blocks.findIndex((block) => block.id === blockId);
    const block = index < 0 ? undefined : doc.blocks[index];
    if (block === undefined) {
      return { blockId, existed: false as const, type: null, text: null, pinRefs: null, index: Math.max(0, doc.blocks.length) };
    }
    return {
      blockId,
      existed: true as const,
      type: block.type,
      text: block.text,
      pinRefs: block.pinRefs,
      index,
    };
  });
  return { docId: doc.id, rev, entries };
}

export function openSqliteStore(options: SqliteStoreOptions): SqliteStore {
  return SqliteStore.open(options);
}
