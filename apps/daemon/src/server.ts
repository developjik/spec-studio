import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AiKeychainEraseSchema,
  AiKeychainRequestSchema,
  CommandSchema,
  findPreset,
  ProjectBundleSchema,
  type CredentialPort,
  type Project,
  type ProjectBundle,
} from '@spec-studio/protocol';
import { DomainError, remapProject, ungroundedRequirements, type DomainErrorCode } from '@spec-studio/core';
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
import { AiRequestError, aiStatus, planAiProposal, testAiConnection } from './ai.js';
import { AgentService, dispatchAgentCommand, type DeclaredTool } from './agent.js';
import { createIpcKeychainPort } from './keychain.js';
import { isTerminalRunState, RunRefusal, type ModelPort } from '@spec-studio/agent';

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
  /** Defaults to `process.env`; tests pass their own map. */
  env?: Record<string, string | undefined>;
  /** Injected in tests so the AI routes never leave the machine. */
  aiFetch?: typeof fetch;
  /**
   * The OS keychain port. `undefined` auto-detects: a daemon forked as the
   * desktop's utility process gets one over `process.parentPort`, a standalone
   * daemon gets `null`. Tests pass a double — or `null` to force "no keychain".
   */
  keychain?: CredentialPort | null;
  /**
   * Set by the desktop shell: every /api request must then carry this value in
   * `x-daemon-token`. A browser vouches for its Origin header; a local process
   * does not — the token is the real gate for the sidecar daemon.
   */
  authToken?: string;
  /** The agent runtime's doubles — a scripted model in tests, declared tools. */
  agent?: { modelPort?: ModelPort; tools?: DeclaredTool[]; fetchImpl?: typeof fetch };
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
    docs: project.docs.map((doc) => ({
      id: doc.id,
      title: doc.title,
      kind: doc.kind,
      blocks: doc.blocks.length,
    })),
    proposalState: project.proposals.at(-1)?.state ?? null,
    /** F3-3: requirements with no evidence behind them — the spec sidepanel's 미근거 list. */
    ungroundedReqs: ungroundedRequirements(project).map((node) => node.id),
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
  const store = options.store ?? openSqliteStore({ file: options.dbPath, actor: 'person:owner' });
  const env = options.env ?? process.env;
  const keychain = options.keychain === undefined ? createIpcKeychainPort() : options.keychain;
  // E3 F1 (AC-2): a daemon that comes back marks every run that was live
  // when it left — the person then chooses resume or cancel for each.
  store.markInterruptedRuns();
  const agent = new AgentService({
    store,
    env,
    ...(options.agent?.modelPort === undefined ? {} : { modelPort: options.agent.modelPort }),
    ...(options.agent?.tools === undefined ? {} : { tools: options.agent.tools }),
    ...(options.agent?.fetchImpl === undefined ? {} : { fetchImpl: options.agent.fetchImpl }),
    ...(options.aiFetch === undefined ? {} : { fetchImpl: options.aiFetch }),
  });
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

    // Preflight answers above carry no custom headers by design; every real
    // request below must prove it belongs to this desktop session.
    if (options.authToken !== undefined) {
      const presented = req.headers['x-daemon-token'];
      if (presented !== options.authToken) {
        throw new HttpError(401, 'daemon_unauthorized', '데몬 세션 토큰이 없거나 일치하지 않습니다.');
      }
    }

    // GET /api/ai — which providers have a key in the daemon's environment.
    // It answers with booleans: the key itself never leaves the process.
    if (segments[1] === 'ai' && segments.length === 2) {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'GET만 허용됩니다.');
      return send(res, 200, { status: await aiStatus(env, keychain) });
    }

    // POST /api/ai/test — one small call, for the settings panel's badge.
    if (segments[1] === 'ai' && segments[2] === 'test' && segments.length === 3) {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'POST만 허용됩니다.');
      const body = asObject(await readBody(req));
      const result = await testAiConnection(body, {
        env,
        keychain,
        ...(options.aiFetch === undefined ? {} : { fetchImpl: options.aiFetch }),
      });
      return send(res, 200, { result });
    }

    // POST /api/ai/keychain/store|erase — the desktop shell's safeStorage, via
    // IPC. A stored key is write-only: these routes take it in or drop it, and
    // never hand it back.
    if (segments[1] === 'ai' && segments[2] === 'keychain' && segments.length === 4) {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'POST만 허용됩니다.');
      const body = asObject(await readBody(req));
      if (keychain === null) {
        throw new HttpError(
          501,
          'keychain_unavailable',
          '키체인은 데스크톱 앱에서만 사용할 수 있습니다. 이 창의 메모리나 환경변수를 쓰세요.',
        );
      }
      if (segments[3] === 'store') {
        const { presetId, apiKey } = AiKeychainRequestSchema.parse(body);
        const preset = findPreset(presetId);
        if (preset === undefined) {
          throw new HttpError(404, 'preset_unknown', '알 수 없는 프리셋입니다.');
        }
        try {
          await keychain.store?.(preset.provider, presetId, apiKey);
        } catch (error) {
          throw new HttpError(
            503,
            'keychain_write_failed',
            `키체인에 저장하지 못했습니다. ${error instanceof Error ? error.message : ''}`.trim(),
          );
        }
        return send(res, 200, { saved: true, presetId });
      }
      if (segments[3] === 'erase') {
        const { presetId } = AiKeychainEraseSchema.parse(body);
        const preset = findPreset(presetId);
        if (preset === undefined) {
          throw new HttpError(404, 'preset_unknown', '알 수 없는 프리셋입니다.');
        }
        try {
          await keychain.erase?.(preset.provider, presetId);
        } catch {
          throw new HttpError(503, 'keychain_erase_failed', '키체인에서 삭제하지 못했습니다.');
        }
        return send(res, 200, { erased: true, presetId });
      }
      throw new HttpError(404, 'not_found', '없는 경로입니다.');
    }

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

    // POST /api/projects/:id/ai/proposal — the model drafts, the store decides.
    if (action === 'ai' && segments[4] === 'proposal' && segments.length === 5) {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'POST만 허용됩니다.');
      const body = await readBody(req);
      const plan = await planAiProposal(project, body, {
        env,
        keychain,
        ...(options.aiFetch === undefined ? {} : { fetchImpl: options.aiFetch }),
      });
      const outcome = await store.execute(projectId, plan.command);
      return send(res, 200, {
        project: outcome.project,
        seq: outcome.seq,
        opSeq: outcome.opSeq,
        events: outcome.events,
        source: plan.source,
        provider: plan.provider,
        model: plan.model,
        note: plan.note,
        revert: store.lastRevertable(projectId),
      });
    }

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
      dispatchAgentCommand(agent, projectId, parsed.data, outcome);
      return send(res, 200, {
        project: outcome.project,
        seq: outcome.seq,
        opSeq: outcome.opSeq,
        events: outcome.events,
        revert: store.lastRevertable(projectId),
      });
    }

    // GET /api/projects/:id/runs — the run list a UI (or a test) polls.
    if (action === 'runs' && segments.length === 4) {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'GET만 허용됩니다.');
      return send(res, 200, { runs: store.listRuns().filter((run) => run.projectId === projectId) });
    }

    // GET /api/projects/:id/runs/:runId — one run, its log and checkpoint.
    if (action === 'runs' && segments.length === 5) {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'GET만 허용됩니다.');
      const runId = segments[4] ?? '';
      const run = store.getRun(runId);
      if (run === null || run.projectId !== projectId) {
        throw new HttpError(404, 'run_not_found', '그런 런이 없습니다.');
      }
      return send(res, 200, {
        run,
        log: store.runLog(runId),
        checkpoint: store.latestCheckpoint(runId),
      });
    }

    // GET /api/projects/:id/runs/:runId/events — AC-9 progress as an SSE
    // stream: a snapshot first, then run and log deltas until the run ends.
    if (action === 'runs' && segments.length === 6 && segments[5] === 'events') {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'GET만 허용됩니다.');
      const runId = segments[4] ?? '';
      const initial = store.getRun(runId);
      if (initial === null || initial.projectId !== projectId) {
        throw new HttpError(404, 'run_not_found', '그런 런이 없습니다.');
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('connection', 'keep-alive');
      res.flushHeaders();
      const emit = (name: string, data: unknown) => {
        if (!res.writableEnded) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      let lastRun = initial;
      let sent = 0;
      emit('snapshot', { run: initial, log: store.runLog(runId) });
      sent = store.runLog(runId).length;
      const timer = setInterval(() => {
        if (res.writableEnded) return;
        const record = store.getRun(runId);
        if (
          record !== null &&
          (record.state !== lastRun.state ||
            record.interrupted !== lastRun.interrupted ||
            record.outwardAt !== lastRun.outwardAt ||
            record.endedAt !== lastRun.endedAt)
        ) {
          lastRun = record;
          emit('run', record);
        }
        const lines = store.runLog(runId);
        for (; sent < lines.length; sent += 1) {
          emit('log', { seq: sent + 1, ...lines[sent] });
        }
        if (record !== null && isTerminalRunState(record.state)) {
          clearInterval(timer);
          res.end();
        }
      }, 200);
      res.on('close', () => clearInterval(timer));
      return;
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
          // Publishing prints the spec; research notes stay in the project.
          doc: project.docs.find((doc) => doc.kind === 'spec') ?? project.docs[0] ?? null,
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
          doc: project.docs.find((doc) => doc.kind === 'spec') ?? project.docs[0] ?? null,
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
    res.setHeader('access-control-allow-headers', 'content-type, x-daemon-token');
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

/**
 * W2's refusal surface: every predictable `run.*` rejection is a 4xx a client
 * can branch on — `code` carries the cause, never the message text.
 *
 *   404 run_missing         the runId names nothing in this database
 *   403 run_scope           the run (or the task) belongs to another project
 *   409 run_terminal        the run already ended — every command refuses
 *   409 run_not_asking      run.answer outside needs_input
 *   409 run_not_interrupted run.resume without a restart flag
 *   400 invalid_input       a sqlite constraint the domain guards let through
 *
 * node:sqlite throws plain `Error`s stamped with `errcode`/`errstr` — no
 * dedicated class to `instanceof`. Whatever reaches here past the domain
 * checks is still a rejected input, not a crashed server: the answer is a
 * sanitized 400 and the raw sqlite wording stays in the daemon's log, never
 * in the response body.
 */
function isSqliteFailure(error: unknown): error is Error & { errcode: number; errstr: string } {
  return error instanceof Error && 'errcode' in error && 'errstr' in error;
}
const DOMAIN_ERROR_STATUS: Readonly<Partial<Record<DomainErrorCode, number>>> = {
  run_missing: 404,
  run_scope: 403,
};

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof AiRequestError) return new HttpError(error.status, error.code, error.message);
  if (error instanceof RunRefusal) return new HttpError(409, error.code, error.message);
  if (error instanceof DomainError) {
    return new HttpError(DOMAIN_ERROR_STATUS[error.code] ?? 400, error.code, error.message);
  }
  if (error instanceof PublishError) return new HttpError(400, error.code, error.message);
  if (error instanceof ConfluenceError) {
    return new HttpError(502, 'confluence_error', error.message, error.detail);
  }
  if (isSqliteFailure(error)) {
    console.error('sqlite refusal reached the safety net:', error.message);
    return new HttpError(400, 'invalid_input', '저장소가 거절한 요청입니다.');
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
