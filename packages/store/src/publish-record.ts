import type { DatabaseSync } from 'node:sqlite';
import { newSuffix } from './mapping';

/**
 * A publish record says what left the app and where it landed. W3 writes one
 * per successful Confluence copy, carrying the `spec_hash` that was published —
 * which is what makes a second publish of the same spec a lookup instead of a
 * second page.
 */
export type PublishTarget = 'confluence' | 'notion' | 'jira' | 'local';
export type PublishOutputKind = 'body' | 'overlay-png' | 'spec-html' | 'qa-csv' | 'bundle';
export type PublishStatus = 'intent' | 'ok' | 'failed' | 'blocked';

export interface PublishRecord {
  id: string;
  projectId: string;
  screenId: string | null;
  target: PublishTarget;
  spaceKey: string | null;
  pageId: string | null;
  version: number | null;
  outputKind: PublishOutputKind;
  status: PublishStatus;
  specHash: string | null;
  remoteUrl: string | null;
  idemKey: string;
  note: string | null;
  publishedAt: string | null;
  at: string;
}

export interface PublishRecordInput {
  projectId: string;
  screenId?: string | null;
  target: PublishTarget;
  spaceKey: string;
  pageId: string | null;
  version?: number | null;
  outputKind?: PublishOutputKind;
  status: PublishStatus;
  specHash: string | null;
  remoteUrl: string | null;
  idemKey: string;
  note?: string | null;
  publishedAt: string | null;
  at: string;
  id?: string;
}

interface PublishRow {
  id: string;
  project_id: string;
  screen_id: string | null;
  target: string;
  space_key: string | null;
  page_id: string | null;
  version: number | null;
  output_kind: string;
  status: string;
  spec_hash: string | null;
  remote_url: string | null;
  idem_key: string;
  note: string | null;
  published_at: string | null;
  at: string;
}

const COLUMNS =
  'id, project_id, screen_id, target, space_key, page_id, version, output_kind, status, ' +
  'spec_hash, remote_url, idem_key, note, published_at, at';

export function publishFromRow(row: PublishRow): PublishRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    screenId: row.screen_id,
    target: row.target as PublishTarget,
    spaceKey: row.space_key,
    pageId: row.page_id,
    version: row.version === null ? null : Number(row.version),
    outputKind: row.output_kind as PublishOutputKind,
    status: row.status as PublishStatus,
    specHash: row.spec_hash,
    remoteUrl: row.remote_url,
    idemKey: row.idem_key,
    note: row.note,
    publishedAt: row.published_at,
    at: row.at,
  };
}

export function newPublishId(): string {
  return `PB_${newSuffix(12)}`;
}

/**
 * Writes a publish record, upserting on the idempotency key. An `intent` row
 * that later succeeds becomes `ok` in place, so a crash between the remote
 * write and the local record cannot leave two intent rows behind either.
 */
export function savePublishRecord(db: DatabaseSync, input: PublishRecordInput): PublishRecord {
  const id = input.id ?? newPublishId();
  db.prepare(
    `INSERT INTO publish_record (${COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(target, idem_key) DO UPDATE SET
       page_id      = excluded.page_id,
       version      = excluded.version,
       status       = excluded.status,
       spec_hash    = excluded.spec_hash,
       remote_url   = excluded.remote_url,
       note         = excluded.note,
       published_at = excluded.published_at,
       at           = excluded.at`,
  ).run(
    id,
    input.projectId,
    input.screenId ?? null,
    input.target,
    input.spaceKey,
    input.pageId,
    input.version ?? null,
    input.outputKind ?? 'bundle',
    input.status,
    input.specHash,
    input.remoteUrl,
    input.idemKey,
    input.note ?? null,
    input.publishedAt,
    input.at,
  );
  const row = db
    .prepare('SELECT ' + COLUMNS + ' FROM publish_record WHERE target = ? AND idem_key = ?')
    .get(input.target, input.idemKey) as unknown as PublishRow;
  return publishFromRow(row);
}

export function listPublishRecords(
  db: DatabaseSync,
  projectId: string,
  limit = 20,
): PublishRecord[] {
  const rows = db
    .prepare(
      'SELECT ' +
        COLUMNS +
        ' FROM publish_record WHERE project_id = ? ORDER BY at DESC, rowid DESC LIMIT ?',
    )
    .all(projectId, limit) as unknown as PublishRow[];
  return rows.map(publishFromRow);
}

export function findPublishBySpec(
  db: DatabaseSync,
  input: {
    projectId: string;
    screenId?: string;
    target: PublishTarget;
    spaceKey: string;
    specHash: string;
  },
): PublishRecord | null {
  const row = db
    .prepare(
      'SELECT ' +
        COLUMNS +
        ' FROM publish_record ' +
        "WHERE project_id = ? AND target = ? AND space_key = ? AND spec_hash = ? AND (? IS NULL OR screen_id = ?) AND status = 'ok' " +
        'ORDER BY at DESC, rowid DESC LIMIT 1',
    )
    .get(
      input.projectId,
      input.target,
      input.spaceKey,
      input.specHash,
      input.screenId ?? null,
      input.screenId ?? null,
    ) as unknown as PublishRow | undefined;
  return row === undefined ? null : publishFromRow(row);
}

export function findLatestPublish(
  db: DatabaseSync,
  input: {
    projectId: string;
    screenId?: string;
    target: PublishTarget;
    spaceKey: string;
  },
): PublishRecord | null {
  const row = db
    .prepare(
      'SELECT ' +
        COLUMNS +
        ' FROM publish_record ' +
        "WHERE project_id = ? AND target = ? AND space_key = ? AND (? IS NULL OR screen_id = ?) AND status = 'ok' AND page_id IS NOT NULL " +
        'ORDER BY at DESC, rowid DESC LIMIT 1',
    )
    .get(
      input.projectId,
      input.target,
      input.spaceKey,
      input.screenId ?? null,
      input.screenId ?? null,
    ) as unknown as PublishRow | undefined;
  return row === undefined ? null : publishFromRow(row);
}
