import type {
  AiProvider,
  AiProposalMode,
  AiProposalSource,
  Command,
  Project,
  ProjectBundle,
} from '@spec-studio/protocol';

/**
 * The browser's only door to the project: HTTP on the loopback daemon.
 * `apps/web` never imports the store (`renderer-never-touches-store`), so every
 * read and write in SQLite mode passes through here.
 */

export const DAEMON_URL: string =
  (import.meta.env.VITE_SPEC_STUDIO_DAEMON as string | undefined) ?? 'http://127.0.0.1:8787';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The loopback daemon can only answer a page served from the same machine.
 * On a static public host (the GitHub Pages demo) there is none, and an https
 * page asking `http://127.0.0.1` is refused as mixed content — so the probe is
 * skipped there and the app opens straight into browser mode with no failed
 * request on the console. An explicitly configured daemon URL is always tried.
 */
export function daemonProbeAllowed(): boolean {
  if ((import.meta.env.VITE_SPEC_STUDIO_DAEMON as string | undefined) !== undefined) return true;
  return LOOPBACK_HOSTS.has(window.location.hostname);
}

export type DaemonStatus = 'checking' | 'connected' | 'offline';

export interface DaemonProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  screenTitle: string | null;
  screenCode: string | null;
  pins: number;
  figmaUrl: string | null;
  docTitle: string | null;
  blocks: number;
  proposalState: string | null;
  graphNodes: number;
  graphLinks: number;
  graphProposalState: string | null;
}

/** The adopted proposal a revert button would restore (W4). */
export interface RevertableView {
  seq: number;
  at: string;
  summary: string;
  proposalId: string | null;
  blocks: number;
  kind: 'doc' | 'graph';
  nodes: number;
}

export interface PublishRecordView {
  id: string;
  projectId: string;
  screenId: string | null;
  target: string;
  spaceKey: string | null;
  pageId: string | null;
  version: number | null;
  outputKind: string;
  status: 'intent' | 'ok' | 'failed' | 'blocked';
  specHash: string | null;
  remoteUrl: string | null;
  note: string | null;
  publishedAt: string | null;
  at: string;
}

export interface PublishPreviewView {
  specHash: string;
  title: string;
  body: string;
  attachments: Array<{
    kind: string;
    fileName: string;
    label: string;
    detail: string;
    contentType: string;
    bytes: number;
  }>;
  plan: 'create' | 'update' | 'skip';
  page: { id: string; url: string } | null;
}

export interface PublishOutcomeView {
  status: 'created' | 'updated' | 'skipped';
  specHash: string;
  page: { id: string; title: string; version: number; url: string } | null;
  record: PublishRecordView;
  attachments: Array<{ fileName: string; action: 'created' | 'updated' }>;
  message: string;
}

export interface ConfluenceTargetView {
  baseUrl: string;
  space: string;
  email: string;
  apiToken: string;
}

export type PublishModeView = 'auto' | 'create' | 'update';

/** What the AI settings panel sends; the key lives in this object and nowhere else. */
export interface AiRequestView {
  provider: AiProvider;
  model: string;
  endpoint: string | null;
  apiKey: string;
}

export interface AiProviderStatusView {
  provider: AiProvider;
  hasEnvKey: boolean;
  defaultModel: string;
  defaultEndpoint: string | null;
}

export interface AiStatusView {
  providers: AiProviderStatusView[];
  localAvailable: boolean;
}

export interface AiTestResultView {
  ok: boolean;
  provider: AiProvider;
  model: string;
  latencyMs: number;
  message: string;
}

export interface AiProposalOutcomeView {
  project: Project;
  opSeq: number;
  events: unknown[];
  source: AiProposalSource;
  provider: AiProvider;
  model: string;
  note: string;
}

export class DaemonError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DaemonError';
    this.code = code;
  }
}

interface ErrorPayload {
  error?: { code?: string; message?: string };
}

export class DaemonClient {
  readonly baseUrl: string;

  constructor(baseUrl: string = DAEMON_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** A short timeout: when no daemon is running the app should fall back fast. */
  async health(timeoutMs = 1600): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async listProjects(): Promise<DaemonProjectSummary[]> {
    const body = await this.#request<{ projects: DaemonProjectSummary[] }>('/api/projects');
    return body.projects;
  }

  async createProject(name: string): Promise<Project> {
    const body = await this.#request<{ project: Project }>('/api/projects', {
      method: 'POST',
      body: { name },
    });
    return body.project;
  }

  async readProject(
    projectId: string,
  ): Promise<{ project: Project; records: PublishRecordView[]; revert: RevertableView | null }> {
    return this.#request(`/api/projects/${encodeURIComponent(projectId)}`);
  }

  async execute(
    projectId: string,
    command: Command,
  ): Promise<{ project: Project; events: unknown[]; opSeq: number }> {
    return this.#request(`/api/projects/${encodeURIComponent(projectId)}/commands`, {
      method: 'POST',
      body: { command },
    });
  }

  /** Restores `op_log.before` of an adopted proposal; the latest one by default. */
  async revert(
    projectId: string,
    seq?: number,
  ): Promise<{
    project: Project;
    revertedSeq: number;
    blocks: number;
    nodes?: number;
    revert: RevertableView | null;
  }> {
    return this.#request(`/api/projects/${encodeURIComponent(projectId)}/revert`, {
      method: 'POST',
      body: seq === undefined ? {} : { seq },
    });
  }

  /** The whole project as one bundle the browser saves as a file. */
  async exportProject(projectId: string): Promise<ProjectBundle> {
    const body = await this.#request<{ bundle: ProjectBundle }>(
      `/api/projects/${encodeURIComponent(projectId)}/export`,
    );
    return body.bundle;
  }

  /** A bundle becomes a new project; every id is remapped by the daemon. */
  async importBundle(bundle: ProjectBundle): Promise<Project> {
    const body = await this.#request<{ project: Project }>('/api/projects/import', {
      method: 'POST',
      body: { bundle },
    });
    return body.project;
  }

  /** A consistent copy of the SQLite file, written beside it. */
  async backup(projectId: string): Promise<{ path: string; bytes: number; at: string }> {
    const body = await this.#request<{ backup: { path: string; bytes: number; at: string } }>(
      `/api/projects/${encodeURIComponent(projectId)}/backup`,
      { method: 'POST', body: {} },
    );
    return body.backup;
  }

  /** Which providers have a key in the daemon's environment (booleans only). */
  async aiStatus(): Promise<AiStatusView> {
    const body = await this.#request<{ status: AiStatusView }>('/api/ai');
    return body.status;
  }

  async aiTest(input: AiRequestView): Promise<AiTestResultView> {
    const body = await this.#request<{ result: AiTestResultView }>('/api/ai/test', {
      method: 'POST',
      body: {
        provider: input.provider,
        model: input.model,
        endpoint: input.endpoint,
        apiKey: input.apiKey,
      },
    });
    return body.result;
  }

  /**
   * Asks the daemon for a proposal. The answer is the project *after* the card
   * was filed, so the screen and the card can never disagree about what is on
   * the table.
   */
  async aiProposal(
    projectId: string,
    input: AiRequestView & { mode: AiProposalMode },
  ): Promise<AiProposalOutcomeView> {
    return this.#request(`/api/projects/${encodeURIComponent(projectId)}/ai/proposal`, {
      method: 'POST',
      body: {
        mode: input.mode,
        provider: input.provider,
        model: input.model,
        endpoint: input.endpoint,
        apiKey: input.apiKey,
      },
    });
  }

  async publishes(projectId: string): Promise<PublishRecordView[]> {
    const body = await this.#request<{ records: PublishRecordView[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/publishes`,
    );
    return body.records;
  }

  async preview(
    projectId: string,
    input: { space: string; mode: PublishModeView },
  ): Promise<PublishPreviewView> {
    const body = await this.#request<{ preview: PublishPreviewView }>(
      `/api/projects/${encodeURIComponent(projectId)}/publish/preview`,
      { method: 'POST', body: input },
    );
    return body.preview;
  }

  async publish(
    projectId: string,
    input: {
      target: ConfluenceTargetView;
      mode: PublishModeView;
      overlayPng: string;
    },
  ): Promise<PublishOutcomeView> {
    const body = await this.#request<{ outcome: PublishOutcomeView }>(
      `/api/projects/${encodeURIComponent(projectId)}/publish`,
      { method: 'POST', body: input },
    );
    return body.outcome;
  }

  async #request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: { 'content-type': 'application/json' },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new DaemonError(
        'daemon_unreachable',
        'SQLite 데몬에 연결하지 못했습니다. 데몬이 실행 중인지 확인해 주세요.',
      );
    }

    const text = await response.text();
    const parsed = text === '' ? {} : (JSON.parse(text) as unknown);
    if (!response.ok) {
      const error = (parsed as ErrorPayload).error;
      throw new DaemonError(
        error?.code ?? 'daemon_error',
        error?.message ?? `데몬 응답 ${response.status}`,
      );
    }
    return parsed as T;
  }
}

/** Data-URL → base64 payload the daemon decodes. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
