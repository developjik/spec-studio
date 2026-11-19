import type { Command, DomainEvent, Project } from '@spec-studio/protocol';

/**
 * The store owns the schema and is the only writer. The port below is the
 * shape the SQLite adapter (`openSqliteStore`) implements: one command in, one
 * event stream and the new state out, applied in a single transaction.
 */
export { SCHEMA_VERSION } from './schema';

/** Path of the canonical DDL, relative to this package. */
export const SCHEMA_PATH = 'schema/schema.sql';

export interface ExecuteOutcome {
  /** State after the command, numbering already applied by core. */
  project: Project;
  /** Last event sequence in this project's thread. */
  seq: number;
  /** The `op_log` row this command wrote — what a revert names. */
  opSeq: number;
  events: DomainEvent[];
}

export interface RevertableOp {
  seq: number;
  at: string;
  summary: string;
  proposalId: string | null;
  blocks: number;
  /** Which layer the decision belongs to: the document or the object graph. */
  kind: 'doc' | 'graph';
  /** Graph nodes the undo would remove. */
  nodes: number;
}

export interface RevertOutcome {
  project: Project;
  /** The `op_log.seq` of the adopted work that was restored. */
  revertedSeq: number;
  blocks: number;
  /** Graph nodes removed by the undo (0 for a document revert). */
  nodes?: number;
  seq: number;
}

export interface StoreRead {
  readProject(projectId: string): Promise<Project | null>;
  listProjectIds(): Promise<string[]>;
  /** The adopted work still eligible for undo, or null. */
  lastRevertable(projectId: string): RevertableOp | null;
}

export interface StoreCreate {
  createProject(input: { name: string; id?: string; at?: string }): Promise<Project>;
}

export interface StoreWrite {
  /** Applies a command in one transaction and returns the events it emitted. */
  execute(projectId: string, command: Command): Promise<ExecuteOutcome>;
  /** Restores `op_log.before` of a proposal adoption (the latest one by default). */
  revert(projectId: string, seq?: number): Promise<RevertOutcome>;
}

export interface StorePort extends StoreRead, StoreCreate, StoreWrite {
  close(): Promise<void>;
}

export * from './mapping';
export * from './schema';
export * from './publish-record';
export { SqliteStore, openSqliteStore, type SqliteStoreOptions } from './sqlite-store';
