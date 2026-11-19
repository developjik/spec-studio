import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CommandSchema,
  ProjectBundleSchema,
  type Project,
  type ProjectBundle,
} from '@spec-studio/protocol';
import { DomainError, remapProject } from '@spec-studio/core';
import {
  openSqliteStore,
  SCHEMA_VERSION,
  type PublishRecord,
  type SqliteStore,
} from '@spec-studio/store';
import {
  ConfluenceError,
  PublishError,
  previewPublish,
  publishSpec,
  type PublishMode,
  type PublishRecordPort,
} from '@spec-studio/publish';

/**
 * The local daemon: a loopback-only HTTP API in front of the SQLite store.
 *
 * The browser never opens the database (`renderer-never-touches-store`), so
 * this process is the one writer. It binds 127.0.0.1, accepts requests only
 * from the app's own origins, and keeps credentials in the request that carried
 * them — nothing here writes a token to disk or to a log.
 */

export const DEFAULT_PORT = 8787;
export const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

const BODY_LIMIT = 40 * 1024 * 1024;

export interface DaemonOptions {
  dbPath: string;
  host?: string;
  port?: number;
  allowedOrigins?: readonly string[];
  /** Injected so tests can pin timestamps. */
  now?: () => string;
  /** Injected so tests can reuse a store they already opened. */
  store?: SqliteStore;
  /** Where `POST /api/projects/:id/backup` writes; defaults beside the db file. */
  backupDir?: string;
}

export interface Daemon {
  server: Server;
  store: SqliteStore;
  port: number;
  url: string;
  close(): Promise<void>;
}

interface ErrorBody {
  error: { code: string; message: string; detail?: string };
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;

  constructor(status: number, code: string, message: string, detail?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function projectSummary(project: Project): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    screenTitle: project.screen?.title ?? null,
    screenCode: project.screen?.code ?? null,
    pins: project.pins.length,
    figmaUrl: project.screen?.figmaUrl ?? null,
    docTitle: project.doc?.title ?? null,
    blocks: project.doc?.blocks.length ?? 0,
    proposalState: project.proposal?.state ?? null,
    graphNodes: project.graph.nodes.length,
    graphLinks: project.graph.links.length,
    graphProposalState: project.graphProposal?.state ?? null,
  };
}

function recordJson(record: PublishRecord): Record<string, unknown> {
  return {
    id: record.id,
    projectId: record.projectId,
    screenId: record.screenId,
    target: record.target,
    spaceKey: record.spaceKey,
    pageId: record.pageId,
    version: record.version,
    outputKind: record.outputKind,
    status: record.status,
    specHash: record.specHash,
    remoteUrl: record.remoteUrl,
    note: record.note,
    publishedAt: record.publishedAt,
    at: record.at,
  };
}

function recordPort(store: SqliteStore): PublishRecordPort {
  return {
    async findBySpec(input) {
      return store.findPublishBySpec(input);
    },
    async findLatest(input) {
      return store.findLatestPublish(input);
    },
    async save(input) {
      return store.savePublish(input);
    },
  };
}

function figmaUrlOf(project: Project): string | null {
  const screen = project.screen;
  if (screen === null) return null;
  if (screen.figmaUrl !== undefined && screen.figmaUrl !== null) return screen.figmaUrl;
  return screen.ref.kind === 'figma_frame' ? screen.ref.value : null;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new HttpError(413, 'body_too_large', '요청 본문이 너무 큽니다.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        reject(new HttpError(400, 'invalid_json', 'JSON 본문을 읽지 못했습니다.'));
      }
    });
    req.on('error', reject);
  });
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new HttpError(400, 'invalid_body', '요청 본문이 JSON 객체가 아닙니다.');
  }
  return value as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string, label: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'missing_field', `${label} 값을 입력해 주세요.`);
  }
  return value.trim();
}

function parseMode(value: unknown): PublishMode {
  if (value === undefined || value === 'auto') return 'auto';
  if (value === 'create' || value === 'update') return value;
  throw new HttpError(400, 'invalid_mode', '발행 모드는 auto · create · update 중 하나입니다.');
}

function decodeOverlay(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value === '') {
    throw new HttpError(
      400,
      'overlay_required',
      '오버레이 PNG가 없습니다. 브라우저에서 출력 3종을 만든 뒤 다시 시도해 주세요.',
    );
  }
  const raw = value.replace(/^data:image\/png;base64,/, '');
  const buffer = Buffer.from(raw, 'base64');
  if (buffer.length < 8 || buffer[0] !== 0x89 || buffer.subarray(1, 4).toString('ascii') !== 'PNG') {
    throw new HttpError(400, 'overlay_invalid', '오버레이 PNG 데이터를 읽지 못했습니다.');
  }
  return new Uint8Array(buffer);
}

/**
 * Starts the daemon. `port: 0` binds an ephemeral port, which is how the
 * integration test runs two daemons against the same file without a port clash.
 */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const host = options.host ?? '127.0.0.1';
  const allowed = new Set(options.allowedOrigins ?? DEFAULT_ORIGINS);
  const now = options.now ?? (() => new Date().toISOString());
  if (options.store === undefined && options.dbPath !== ':memory:') {
    // Opening the store creates the file; the directory has to exist first.
    mkdirSync(dirname(options.dbPath), { recursive: true });
  }
  const store = options.store ?? openSqliteStore({ file: options.dbPath });
  const backupDir =
    options.backupDir ??
    (options.dbPath === ':memory:' ? `${process.cwd()}/backups` : `${dirname(options.dbPath)}/backups`);

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !allowed.has(origin)) {
      throw new HttpError(403, 'origin_not_allowed', '허용되지 않은 출처입니다.');
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const segments = url.pathname.split('/').filter((segment) => segment !== '');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (segments[0] !== 'api') throw new HttpError(404, 'not_found', '없는 경로입니다.');

    // GET /api/health
    if (segments[1] === 'health' && segments.length === 2) {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'GET만 허용됩니다.');
      const projectIds = await store.listProjectIds();
      return send(res, 200, {
        ok: true,
        service: 'spec-studio-daemon',
        schemaVersion: SCHEMA_VERSION,
        mode: 'sqlite',
        projects: projectIds.length,
      });
    }

    if (segments[1] !== 'projects') throw new HttpError(404, 'not_found', '없는 경로입니다.');

    // GET /api/projects · POST /api/projects
    if (segments.length === 2) {
      if (req.method === 'GET') {
        const ids = await store.listProjectIds();
        const projects = [];
        for (const id of ids) {
          const project = await store.readProject(id);
          if (project !== null) projects.push(projectSummary(project));
        }
        return send(res, 200, { projects });
      }
      if (req.method === 'POST') {
        const body = asObject(await readBody(req));
        const name = requireString(body, 'name', '프로젝트 이름');
        const project = await store.createProject({ name, at: now() });
        return send(res, 201, { project });
      }
      throw new HttpError(405, 'method_not_allowed', 'GET · POST만 허용됩니다.');
    }

    // POST /api/projects/import — a bundle becomes a new project with new ids.
    if (segments[2] === 'import' && segments.length === 3) {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'POST만 허용됩니다.');
      const body = asObject(await readBody(req));
      const parsed = ProjectBundleSchema.safeParse(body.bundle);
      if (!parsed.success) {
        throw new HttpError(
          400,
          'invalid_bundle',
          'spec-studio 프로젝트 번들이 아닙니다.',
          parsed.error.issues.map((issue) => issue.message).join(' / '),
        );
      }
      const imported = remapProject(parsed.data.project, (kind, nodeType) =>
        store.nextId(kind, nodeType),
      );
      const project = await store.importProject(imported);
      return send(res, 201, { project, sourceProjectId: parsed.data.project.id });
    }

    const projectId = segments[2] ?? '';
    const project = await store.readProject(projectId);
    if (project === null) throw new HttpError(404, 'project_not_found', '프로젝트를 찾지 못했습니다.');

    // GET /api/projects/:id
    if (segments.length === 3) {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'GET만 허용됩니다.');
      return send(res, 200, {
        project,
        records: store.listPublishes(projectId).map(recordJson),
        revert: store.lastRevertable(projectId),
      });
    }

    const action = segments[3];

    // POST /api/projects/:id/commands
    if (action === 'commands' && segments.length === 4) {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'POST만 허용됩니다.');
      const body = asObject(await readBody(req));
      const parsed = CommandSchema.safeParse(body.command);
      if (!parsed.success) {
        throw new HttpError(
          400,
          'invalid_command',
          '명령 형식이 올바르지 않습니다.',
          parsed.error.issues.map((issue) => issue.message).join(' / '),
        );
      }
      const outcome = await store.execute(projectId, parsed.data);
      return send(res, 200, {
        project: outcome.project,
        seq: outcome.seq,
        opSeq: outcome.opSeq,
        events: outcome.events,
      });
    }

    // POST /api/projects/:id/revert — restores op_log.before of an adoption.
    if (action === 'revert' && segments.length === 4) {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'POST만 허용됩니다.');
      const body = asObject(await readBody(req));
      const rawSeq = body.seq;
      if (rawSeq !== undefined && (typeof rawSeq !== 'number' || !Number.isInteger(rawSeq) || rawSeq < 1)) {
        throw new HttpError(400, 'invalid_seq', '되돌릴 기록 번호를 확인해 주세요.');
      }
      const outcome = await store.revert(projectId, rawSeq as number | undefined);
      return send(res, 200, {
        project: outcome.project,
        revertedSeq: outcome.revertedSeq,
        blocks: outcome.blocks,
        seq: outcome.seq,
        revert: store.lastRevertable(projectId),
      });
    }

    // GET /api/projects/:id/export — the whole project as one JSON bundle.
    if (action === 'export' && segments.length === 4) {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'GET만 허용됩니다.');
      const bundle: ProjectBundle = {
        format: 'spec-studio.bundle',
        version: 1,
        exportedAt: now(),
        project,
      };
      return send(res, 200, { bundle });
    }

    // POST /api/projects/:id/backup — a consistent copy of the SQLite file.
    if (action === 'backup' && segments.length === 4) {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'POST만 허용됩니다.');
      const backup = store.backupTo(backupDir);
      return send(res, 200, { backup: { ...backup, projectId } });
    }

    // GET /api/projects/:id/publishes
    if (action === 'publishes' && segments.length === 4) {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'GET만 허용됩니다.');
      const limit = Number(url.searchParams.get('limit') ?? '20');
      return send(res, 200, {
        records: store.listPublishes(projectId, Number.isFinite(limit) ? limit : 20).map(recordJson),
      });
    }

    // POST /api/projects/:id/publish/preview
    if (action === 'publish' && segments[4] === 'preview' && segments.length === 5) {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'POST만 허용됩니다.');
      const body = asObject(await readBody(req));
      const screen = project.screen;
      if (screen === null) throw new HttpError(400, 'no_screen', '화면을 먼저 등록해 주세요.');
      const space = requireString(body, 'space', 'Space ID 또는 Key');
      const preview = await previewPublish(
        {
          projectId,
          projectName: project.name,
          screen,
          pins: project.pins,
          pinSeq: project.pinSeq,
          figmaUrl: figmaUrlOf(project),
          doc: project.doc,
          generatedAt: now(),
          mode: parseMode(body.mode),
          target: { space },
        },
        { records: recordPort(store) },
      );
      return send(res, 200, { preview });
    }

    // POST /api/projects/:id/publish
    if (action === 'publish' && segments.length === 4) {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'POST만 허용됩니다.');
      const body = asObject(await readBody(req));
      const screen = project.screen;
      if (screen === null) throw new HttpError(400, 'no_screen', '화면을 먼저 등록해 주세요.');
      const target = asObject(body.target);
      const outcome = await publishSpec(
        {
          projectId,
          projectName: project.name,
          screen,
          pins: project.pins,
          pinSeq: project.pinSeq,
          figmaUrl: figmaUrlOf(project),
          doc: project.doc,
          generatedAt: now(),
          mode: parseMode(body.mode),
          overlayPng: decodeOverlay(body.overlayPng),
          target: {
            baseUrl: requireString(target, 'baseUrl', 'Confluence 주소'),
            space: requireString(target, 'space', 'Space ID 또는 Key'),
            email: requireString(target, 'email', '이메일'),
            apiToken: requireString(target, 'apiToken', 'API 토큰'),
            ...(typeof target.parentPageId === 'string' && target.parentPageId.trim() !== ''
              ? { parentPageId: target.parentPageId.trim() }
              : {}),
          },
        },
        { records: recordPort(store) },
      );
      return send(res, 200, { outcome });
    }

    throw new HttpError(404, 'not_found', '없는 경로입니다.');
  };

  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    res.setHeader(
      'access-control-allow-origin',
      typeof origin === 'string' && allowed.has(origin) ? origin : 'null',
    );
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('vary', 'origin');

    if (typeof origin === 'string' && !allowed.has(origin)) {
      send(res, 403, {
        error: { code: 'origin_not_allowed', message: '허용되지 않은 출처입니다.' },
      });
      return;
    }

    handle(req, res).catch((error: unknown) => {
      const failure = toHttpError(error);
      send(res, failure.status, {
        error: {
          code: failure.code,
          message: failure.message,
          ...(failure.detail === undefined ? {} : { detail: failure.detail }),
        },
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_PORT, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? DEFAULT_PORT);

  return {
    server,
    store,
    port,
    url: `http://${host}:${port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
    },
  };
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof DomainError) return new HttpError(400, error.code, error.message);
  if (error instanceof PublishError) return new HttpError(400, error.code, error.message);
  if (error instanceof ConfluenceError) {
    return new HttpError(502, 'confluence_error', error.message, error.detail);
  }
  return new HttpError(
    500,
    'internal_error',
    error instanceof Error ? error.message : '알 수 없는 오류가 납니다.',
  );
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(payload));
  res.end(payload);
}

export type { ErrorBody };
