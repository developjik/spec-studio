import type { Doc, Pin, Screen } from '@spec-studio/protocol';
import { ConfluenceClient, type RemotePage } from './confluence';
import { buildPublishPackage, type PublishPackage } from './spec';
import type { PublishAttachmentInfo } from './body';

/**
 * Publish orchestration: decide whether this spec is already out there, then
 * create or update exactly one page and upload exactly three attachments.
 *
 * The record port is the only storage the publisher knows. The daemon backs it
 * with SQLite; tests back it with a map. Nothing in this package imports the
 * store, so a host other than this app can reuse the flow.
 */

export type PublishMode = 'auto' | 'create' | 'update';
export type PublishPlan = 'create' | 'update' | 'skip';

export interface PublishRecordSnapshot {
  id: string;
  pageId: string | null;
  remoteUrl: string | null;
  specHash: string | null;
  spaceKey: string | null;
  publishedAt: string | null;
  status: string;
}

export interface PublishRecordSaveInput {
  projectId: string;
  screenId: string | null;
  target: 'confluence';
  spaceKey: string;
  pageId: string | null;
  version: number | null;
  outputKind: 'bundle';
  status: 'intent' | 'ok' | 'failed';
  specHash: string | null;
  remoteUrl: string | null;
  idemKey: string;
  note: string | null;
  publishedAt: string | null;
  at: string;
}

export interface PublishRecordPort {
  findBySpec(input: {
    projectId: string;
    target: 'confluence';
    spaceKey: string;
    specHash: string;
  }): Promise<PublishRecordSnapshot | null>;
  findLatest(input: {
    projectId: string;
    target: 'confluence';
    spaceKey: string;
  }): Promise<PublishRecordSnapshot | null>;
  save(input: PublishRecordSaveInput): Promise<PublishRecordSnapshot>;
}

export interface PublishTargetInput {
  baseUrl: string;
  /** Space id or key, as the user typed it. */
  space: string;
  email: string;
  apiToken: string;
  parentPageId?: string;
}

export interface PublishSpecInput {
  projectId: string;
  projectName: string;
  screen: Screen;
  pins: readonly Pin[];
  pinSeq: number;
  figmaUrl: string | null;
  /** W4: the document beside the screen, when the project has one. */
  doc?: Doc | null;
  generatedAt: string;
  mode: PublishMode;
}

export interface PublishOutcome {
  status: 'created' | 'updated' | 'skipped';
  specHash: string;
  page: { id: string; title: string; version: number; url: string } | null;
  record: PublishRecordSnapshot;
  attachments: Array<{ fileName: string; action: 'created' | 'updated' }>;
  message: string;
}

export interface PublishPreview {
  specHash: string;
  title: string;
  body: string;
  attachments: PublishAttachmentInfo[];
  plan: PublishPlan;
  page: { id: string; url: string } | null;
}

export class PublishError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PublishError';
    this.code = code;
  }
}

/** Confluence space keys are case-insensitive and conventionally upper-case. */
export function normalizeSpaceKey(space: string): string {
  const trimmed = space.trim();
  return /^\d+$/.test(trimmed) ? trimmed : trimmed.toUpperCase();
}

async function decidePlan(
  records: PublishRecordPort,
  input: { projectId: string; spaceKey: string; specHash: string; mode: PublishMode },
): Promise<{ plan: PublishPlan; pageId: string | null; exact: PublishRecordSnapshot | null }> {
  const exact = await records.findBySpec({
    projectId: input.projectId,
    target: 'confluence',
    spaceKey: input.spaceKey,
    specHash: input.specHash,
  });
  if (exact !== null && input.mode !== 'create') {
    return { plan: 'skip', pageId: exact.pageId, exact };
  }
  const latest = await records.findLatest({
    projectId: input.projectId,
    target: 'confluence',
    spaceKey: input.spaceKey,
  });
  if (input.mode === 'update') {
    if (latest?.pageId == null) {
      throw new PublishError(
        'update_without_page',
        '이 스페이스에 이 프로젝트가 발행한 페이지가 없습니다. 먼저 신규 발행해 주세요.',
      );
    }
    return { plan: 'update', pageId: latest.pageId, exact };
  }
  if (input.mode === 'create') return { plan: 'create', pageId: null, exact };
  if (latest?.pageId != null) return { plan: 'update', pageId: latest.pageId, exact };
  return { plan: 'create', pageId: null, exact };
}

export async function previewPublish(
  input: PublishSpecInput & { target: Pick<PublishTargetInput, 'space'> },
  deps: { records: PublishRecordPort },
): Promise<PublishPreview> {
  const spaceKey = normalizeSpaceKey(input.target.space);
  const pkg = buildPublishPackage({
    projectName: input.projectName,
    screen: input.screen,
    pins: input.pins,
    pinSeq: input.pinSeq,
    figmaUrl: input.figmaUrl,
    doc: input.doc ?? null,
    generatedAt: input.generatedAt,
    overlayPng: new Uint8Array(0),
  });
  const { plan, pageId } = await decidePlan(deps.records, {
    projectId: input.projectId,
    spaceKey,
    specHash: pkg.specHash,
    mode: input.mode,
  });
  return {
    specHash: pkg.specHash,
    title: pkg.title,
    body: pkg.body,
    attachments: pkg.attachments.map(({ data: _data, ...info }) => info),
    plan,
    page: pageId === null ? null : { id: pageId, url: '' },
  };
}

export interface PublishRunInput extends PublishSpecInput {
  target: PublishTargetInput;
  /** The overlay is rendered by the caller — it owns the screenshot canvas. */
  overlayPng: Uint8Array;
}

export async function publishSpec(
  input: PublishRunInput,
  deps: { records: PublishRecordPort; client?: ConfluenceClient },
): Promise<PublishOutcome> {
  const spaceKey = normalizeSpaceKey(input.target.space);
  const pkg = buildPublishPackage({
    projectName: input.projectName,
    screen: input.screen,
    pins: input.pins,
    pinSeq: input.pinSeq,
    figmaUrl: input.figmaUrl,
    doc: input.doc ?? null,
    generatedAt: input.generatedAt,
    overlayPng: input.overlayPng,
  });

  const decision = await decidePlan(deps.records, {
    projectId: input.projectId,
    spaceKey,
    specHash: pkg.specHash,
    mode: input.mode,
  });

  if (decision.plan === 'skip' && decision.exact !== null) {
    return {
      status: 'skipped',
      specHash: pkg.specHash,
      page:
        decision.exact.pageId === null
          ? null
          : {
              id: decision.exact.pageId,
              title: pkg.title,
              version: 0,
              url: decision.exact.remoteUrl ?? '',
            },
      record: decision.exact,
      attachments: [],
      message:
        '같은 스펙이 이미 발행되어 있어 새 페이지를 만들지 않았습니다. ' +
        (decision.exact.remoteUrl === null ? '' : decision.exact.remoteUrl),
    };
  }

  const client =
    deps.client ??
    new ConfluenceClient({
      baseUrl: input.target.baseUrl,
      email: input.target.email,
      apiToken: input.target.apiToken,
    });

  const pageId = decision.pageId;
  const idemKey =
    input.mode === 'create'
      ? `${spaceKey}:new:${pkg.specHash}:${input.generatedAt}`
      : `${spaceKey}:${pageId ?? 'new'}:${pkg.specHash}`;

  await deps.records.save({
    projectId: input.projectId,
    screenId: input.screen.id,
    target: 'confluence',
    spaceKey,
    pageId,
    version: null,
    outputKind: 'bundle',
    status: 'intent',
    specHash: pkg.specHash,
    remoteUrl: null,
    idemKey,
    note: null,
    publishedAt: null,
    at: input.generatedAt,
  });

  try {
    const space = await client.resolveSpace(input.target.space);
    const page =
      pageId === null
        ? await client.createPage({
            spaceId: space.id,
            title: pkg.title,
            body: pkg.body,
            ...(input.target.parentPageId === undefined
              ? {}
              : { parentId: input.target.parentPageId }),
          })
        : await client.updatePage(pageId, { title: pkg.title, body: pkg.body });

    const uploaded: Array<{ fileName: string; action: 'created' | 'updated' }> = [];
    for (const attachment of pkg.attachments) {
      const result = await client.uploadAttachment(page.id, {
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        data: attachment.data,
      });
      uploaded.push({ fileName: attachment.fileName, action: result.action });
    }

    const record = await deps.records.save({
      projectId: input.projectId,
      screenId: input.screen.id,
      target: 'confluence',
      spaceKey,
      pageId: page.id,
      version: page.version,
      outputKind: 'bundle',
      status: 'ok',
      specHash: pkg.specHash,
      remoteUrl: page.url,
      idemKey,
      note: `${uploaded.length} attachments`,
      publishedAt: input.generatedAt,
      at: input.generatedAt,
    });

    return {
      status: pageId === null ? 'created' : 'updated',
      specHash: pkg.specHash,
      page: { id: page.id, title: page.title, version: page.version, url: page.url },
      record,
      attachments: uploaded,
      message:
        pageId === null
          ? `새 Confluence 페이지를 만들고 첨부 ${uploaded.length}종을 올렸습니다.`
          : `기존 Confluence 페이지를 갱신하고 첨부 ${uploaded.length}종을 올렸습니다.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.records.save({
      projectId: input.projectId,
      screenId: input.screen.id,
      target: 'confluence',
      spaceKey,
      pageId: pageId,
      version: null,
      outputKind: 'bundle',
      status: 'failed',
      specHash: pkg.specHash,
      remoteUrl: null,
      idemKey,
      note: message.slice(0, 300),
      publishedAt: null,
      at: input.generatedAt,
    });
    throw error;
  }
}

/** Shared by the result view: the page a record points at. */
export function pageFromRecord(record: PublishRecordSnapshot): RemotePage | null {
  if (record.pageId === null) return null;
  return {
    id: record.pageId,
    title: '',
    version: 0,
    url: record.remoteUrl ?? '',
  };
}

export type { PublishPackage };
