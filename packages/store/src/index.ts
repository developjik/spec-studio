import type { Command, Project } from '@spec-studio/protocol';

/**
 * The store owns the schema and is the only writer. W1 ships the schema and
 * its contract test; a runtime adapter (SQLite behind an HTTP/WS daemon) is
 * the next milestone. The port below is the shape that adapter must satisfy —
 * one command in, one event stream and the new state out.
 */
export const SCHEMA_VERSION = 11;

/** Path of the canonical DDL, relative to this package. */
export const SCHEMA_PATH = 'schema/schema.sql';

export interface StoreRead {
  readProject(projectId: string): Promise<Project | null>;
  listProjectIds(): Promise<string[]>;
}

export interface StoreWrite {
  /** Applies a command in one transaction and returns the events it emitted. */
  execute(projectId: string, command: Command): Promise<{ project: Project; seq: number }>;
}

export interface StorePort extends StoreRead, StoreWrite {
  close(): Promise<void>;
}
