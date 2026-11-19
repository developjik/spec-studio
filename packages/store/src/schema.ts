import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/**
 * The DDL lives in `schema/schema.sql` and nowhere else: the contract test
 * reads the same file, so the runtime and the test can never be looking at
 * different schemas.
 */
/**
 * Where the DDL lives. A bundled host (the daemon ships one file and a `schema/`
 * directory beside it) points `SPEC_STUDIO_SCHEMA_DIR` at its copy; running from
 * source falls back to this package's own directory.
 */
export const SCHEMA_DIR =
  process.env.SPEC_STUDIO_SCHEMA_DIR ?? fileURLToPath(new URL('../schema/', import.meta.url));

export const SCHEMA_FILE = join(SCHEMA_DIR, 'schema.sql');

/** `PRAGMA user_version` of the DDL above. */
export const SCHEMA_VERSION = 14;

/**
 * Additive steps applied when an older file is opened. A database is only ever
 * moved forward; opening a newer file with an older build is an error, because
 * that build would not know what the extra columns mean.
 */
export const MIGRATIONS: Readonly<Record<number, string>> = {
  11: join(SCHEMA_DIR, 'migrate-11-12.sql'),
  12: join(SCHEMA_DIR, 'migrate-12-13.sql'),
  13: join(SCHEMA_DIR, 'migrate-13-14.sql'),
};

/**
 * Everything below this line needs FTS5, which is a SQLite build option rather
 * than a given. The runtime applies the rest and records what it skipped, so a
 * database opened on a build without FTS5 still holds projects, screens and
 * pins — only the Korean search index is absent.
 */
export const FTS5_MARKER = '-- @optional-fts5';

export interface SchemaInfo {
  /** The version the DDL claims. */
  expected: number;
  /** What the database actually reports. */
  actual: number;
  /** True when this call is what created the tables. */
  created: boolean;
  /** False when the SQLite build has no FTS5, so the search index was skipped. */
  fts5: boolean;
}

export function hasFts5(db: DatabaseSync): boolean {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.__fts5_probe USING fts5(x)');
    db.exec('DROP TABLE temp.__fts5_probe');
    return true;
  } catch {
    return false;
  }
}

export function splitSchema(ddl: string): { core: string; search: string } {
  const at = ddl.indexOf(FTS5_MARKER);
  if (at < 0) return { core: ddl, search: '' };
  const lineStart = ddl.lastIndexOf('\n', at) + 1;
  return { core: ddl.slice(0, lineStart), search: ddl.slice(at) };
}

export function applySchema(db: DatabaseSync, schemaPath: string = SCHEMA_FILE): SchemaInfo {
  const ddl = readFileSync(schemaPath, 'utf8');
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const before = Number(row?.user_version ?? 0);
  const fts5 = hasFts5(db);

  if (before === 0) {
    const { core, search } = splitSchema(ddl);
    db.exec(core);
    if (fts5 && search !== '') db.exec(search);
  }

  if (before !== 0 && before < SCHEMA_VERSION) {
    // A file two versions behind takes two steps: one migration per version,
    // applied in order, so a long-lived workspace never has to be rebuilt.
    let version = before;
    while (version < SCHEMA_VERSION) {
      const path = MIGRATIONS[version];
      if (path === undefined) {
        throw new Error(`no migration from user_version ${version} to ${SCHEMA_VERSION}`);
      }
      db.exec(readFileSync(path, 'utf8'));
      version += 1;
    }
  }

  const after = Number(
    (db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)
      ?.user_version ?? 0,
  );

  if (after !== SCHEMA_VERSION) {
    throw new Error(
      `graph.db reports user_version ${after}, this build expects ${SCHEMA_VERSION} — run the migration before opening it`,
    );
  }

  return { expected: SCHEMA_VERSION, actual: after, created: before === 0, fts5 };
}

/** One transaction per command: either the whole state change lands or none of it. */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
