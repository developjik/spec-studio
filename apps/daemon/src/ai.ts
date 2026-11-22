import {
  AI_DEFAULT_ENDPOINTS,
  AI_DEFAULT_MODELS,
  AI_ENV_KEYS,
  AI_PRESETS,
  AI_PROVIDERS,
  AiProposalRequestSchema,
  findPreset,
  IdeaIdSchema,
  type AiProposalMode,
  type AiPreset,
  type AiProvider,
  type AiProposalRequest,
  type AiProposalSource,
  type AiStatus,
  type AiTestResult,
  type Command,
  type CredentialPort,
  type CredentialSource,
  type Doc,
  type Project,
  type Project as ProjectType,
} from '@spec-studio/protocol';

import { washBriefDraft } from '@spec-studio/agent';

import {
  AiDraftError,
  AiProviderError,
  buildFallbackBrief,
  isRemote,
  probeProvider,
  requestBriefDraft,
  requestDocDraft,
  requestGraphDraft,
  resolveApiKey,
} from '@spec-studio/ai';
import { DomainError } from '@spec-studio/core';

/**
 * The daemon's half of the AI layer: decide which key to use, ask the model,
 * and hand the store one command.
 *
 * Two rules hold this together. The key exists only inside one request — it is
 * forwarded to the provider and dropped; there is no cache, no settings row,
 * no log line. And the model's answer becomes a *draft* the store validates
 * against the same schemas a person's command goes through, so a model that
 * answers nonsense produces an error, never a half-written project.
 */

export class AiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AiRequestError';
    this.status = status;
    this.code = code;
  }
}

export interface AiRuntime {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** The OS keychain port; null when this daemon has none (standalone, web). */
  keychain?: CredentialPort | null;
}

export interface AiCommandPlan {
  command: Command;
  source: AiProposalSource;
  provider: AiProvider;
  model: string;
  note: string;
}

export async function aiStatus(
  env: Record<string, string | undefined>,
  keychain: CredentialPort | null,
): Promise<AiStatus> {
  const presets = await Promise.all(
    AI_PRESETS.map(async (preset) => {
      try {
        const key = keychain === null ? null : await keychain.resolve(preset.provider, preset.id);
        return { id: preset.id, hasKeychainKey: key !== null };
      } catch {
        // A broken keychain must not fail the status route — report "no key".
        return { id: preset.id, hasKeychainKey: false };
      }
    }),
  );
  return {
    providers: AI_PROVIDERS.map((provider) => ({
      provider,
      hasEnvKey:
        provider !== 'local' && (env[AI_ENV_KEYS[provider]] ?? '').trim() !== '',
      defaultModel: AI_DEFAULT_MODELS[provider],
      defaultEndpoint: provider === 'local' ? null : AI_DEFAULT_ENDPOINTS[provider],
    })),
    localAvailable: true,
    keychainAvailable: keychain !== null,
    presets,
  };
}

async function requireApiKey(
  provider: AiProvider,
  presetId: string | undefined,
  requestKey: string | null | undefined,
  runtime: AiRuntime,
): Promise<{ key: string | null; source: CredentialSource | null }> {
  return resolveApiKey(provider, presetId, requestKey, runtime.env, runtime.keychain ?? null);
}

/**
 * A preset without a default model (Ollama, LM Studio) wants the name typed
 * in; only a bare provider keeps the built-in default.
 */
function defaultModelFor(provider: AiProvider, preset: AiPreset | undefined): string {
  if (preset === undefined) return AI_DEFAULT_MODELS[provider];
  return preset.defaultModel ?? '';
}

/**
 * Which document a proposal targets. `brief` runs on a research doc — the
 * first one when the request does not name one — because a brief *is*
 * research prose; `doc`/default keep the first spec. One registry, one
 * failure code.
 */
function resolveDoc(project: Project, docId: string | undefined, mode: AiProposalMode): Doc {
  const doc =
    docId !== undefined
      ? project.docs.find((candidate) => candidate.id === docId)
      : mode === 'brief'
        ? project.docs.find((candidate) => candidate.kind === 'research')
        : (project.docs.find((candidate) => candidate.kind === 'spec') ?? project.docs[0]);
  if (doc === undefined) {
    throw new DomainError(
      'doc_missing',
      mode === 'brief'
        ? '리서치 문서를 먼저 만들어 주세요'
        : '제안할 문서가 없습니다. 먼저 문서를 만들어 주세요.',
    );
  }
  return doc;
}

function localPlan(project: Project, request: AiProposalRequest, why: string): AiCommandPlan {
  if (request.mode === 'graph') {
    return {
      command: { type: 'graph.proposal.create' },
      source: 'rule',
      provider: 'local',
      model: '',
      note: why,
    };
  }
  if (request.mode === 'brief') {
    // The fallback brief is the same function eval gates; the card carries
    // its draft so core's evidence check runs for rules too.
    const doc = resolveDoc(project, request.docId, 'brief');
    const draft = buildFallbackBrief(project, {
      ideaId: request.ideaId ?? null,
      topic: request.topic ?? null,
      evidenceIds: request.evidenceIds ?? null,
    });
    return {
      command: { type: 'proposal.create', docId: doc.id, draft, source: 'rule', ideaId: ideaIdOf(request) },
      source: 'rule',
      provider: 'local',
      model: '',
      note: why,
    };
  }
  const doc = resolveDoc(project, request.docId, 'doc');
  return {
    command: { type: 'proposal.create', docId: doc.id },
    source: 'rule',
    provider: 'local',
    model: '',
    note: why,
  };
}

/** A request `ideaId` is free text; the command only carries a real idea id. */
function ideaIdOf(request: AiProposalRequest): string | undefined {
  if (request.ideaId === undefined) return undefined;
  const parsed = IdeaIdSchema.safeParse(request.ideaId);
  return parsed.success ? parsed.data : undefined;
}

/** Turns one browser request into the command the store will run. */
export async function planAiProposal(
  project: ProjectType,
  raw: unknown,
  runtime: AiRuntime,
): Promise<AiCommandPlan> {
  const request = AiProposalRequestSchema.parse(raw);
  if (request.mode === 'backlog') {
    // v16 adds the mode and the draft schema; the planner is the next wave's.
    throw new AiRequestError(501, 'backlog_not_ready', '백로그 분해는 아직 준비 중입니다.');
  }
  const preset = findPreset(request.presetId ?? '');
  const model =
    request.model.trim() === '' ? defaultModelFor(request.provider, preset) : request.model.trim();
  const endpoint = request.endpoint ?? preset?.baseUrl ?? null;

  if (!isRemote(request.provider)) {
    return localPlan(project, request, '로컬 규칙으로 만들었습니다. API 키는 쓰지 않았습니다.');
  }

  let apiKey: string;
  if (preset?.authMode === 'none') {
    // A local model server asks for no key; callModel just sends an empty Bearer.
    apiKey = '';
  } else {
    const resolved = await requireApiKey(request.provider, request.presetId, request.apiKey, runtime);
    if (resolved.key === null) {
      return localPlan(
        project,
        request,
        'API 키가 없어 로컬 규칙으로 만들었습니다. 키를 넣으면 LLM 제안을 씁니다.',
      );
    }
    apiKey = resolved.key;
  }
  if (model === '') {
    throw new AiRequestError(400, 'model_required', '모델 이름을 입력해 주세요.');
  }

  try {
    if (request.mode === 'graph') {
      const { draft, latencyMs } = await requestGraphDraft({
        provider: request.provider,
        apiKey,
        model,
        endpoint,
        project,
        ...(runtime.fetchImpl === undefined ? {} : { fetchImpl: runtime.fetchImpl }),
      });
      return {
        command: {
          type: 'graph.proposal.create',
          draft,
          source: 'llm',
          provider: request.provider,
          model,
        },
        source: 'llm',
        provider: request.provider,
        model,
        note: `LLM이 초안 ${draft.nodes.length}개를 만들었습니다 (${latencyMs}ms).`,
      };
    }

    if (request.mode === 'brief') {
      const doc = resolveDoc(project, request.docId, 'brief');
      const { draft, latencyMs } = await requestBriefDraft({
        provider: request.provider,
        apiKey,
        model,
        endpoint,
        project,
        brief: {
          ideaId: request.ideaId ?? null,
          topic: request.topic ?? null,
          evidenceIds: request.evidenceIds ?? null,
        },
        ...(runtime.fetchImpl === undefined ? {} : { fetchImpl: runtime.fetchImpl }),
      });
      // P3-2 (기획 일관 적용 확정): this path runs no web tool, so no url is
      // tool-reported — the same AC-3 wash empties every invented citation.
      // Grounding here lives in evidenceRefs (E_…), which pass through
      // untouched; a claim left with nothing says 근거 없음 honestly, and the
      // golden set is unaffected (its brief family rides the rule fallback).
      const washed = washBriefDraft(draft, new Set());
      return {
        command: {
          type: 'proposal.create',
          docId: doc.id,
          draft: washed.draft,
          source: 'llm',
          provider: request.provider,
          model,
          ideaId: ideaIdOf(request),
        },
        source: 'llm',
        provider: request.provider,
        model,
        note: `LLM이 브리프 주장 ${washed.draft.claims.length}개를 만들었습니다 (${latencyMs}ms)${
          washed.removedUrls.length > 0 ? ` · 근거 없는 출처 ${washed.removedUrls.length}건 세척` : ''
        }`,
      };
    }

    const doc = resolveDoc(project, request.docId, 'doc');
    const { draft, latencyMs } = await requestDocDraft({
      provider: request.provider,
      apiKey,
      model,
      endpoint,
      project,
      docId: doc.id,
      ...(runtime.fetchImpl === undefined ? {} : { fetchImpl: runtime.fetchImpl }),
    });
    return {
      command: {
        type: 'proposal.create',
        docId: doc.id,
        draft,
        source: 'llm',
        provider: request.provider,
        model,
      },
      source: 'llm',
      provider: request.provider,
      model,
      note: `LLM이 문단 ${draft.patches.length}개의 patch를 만들었습니다 (${latencyMs}ms).`,
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (error instanceof AiDraftError) {
      throw new AiRequestError(
        422,
        'ai_draft_invalid',
        `모델 응답을 초안으로 읽지 못했습니다. ${error.message}`,
      );
    }
    if (error instanceof AiProviderError) {
      throw new AiRequestError(
        502,
        `ai_${error.code}`,
        `${error.message} 모델과 Endpoint를 확인해 주세요. (API 키는 저장되지 않습니다.)`,
      );
    }
    throw error;
  }
}

export async function testAiConnection(
  raw: unknown,
  runtime: AiRuntime,
): Promise<AiTestResult> {
  const request = AiProposalRequestSchema.pick({
    provider: true,
    model: true,
    endpoint: true,
    apiKey: true,
    presetId: true,
  }).parse(raw);
  const preset = findPreset(request.presetId ?? '');
  const model =
    request.model.trim() === '' ? defaultModelFor(request.provider, preset) : request.model.trim();
  const endpoint = request.endpoint ?? preset?.baseUrl ?? null;

  if (!isRemote(request.provider)) {
    return {
      ok: true,
      provider: 'local',
      model: '',
      latencyMs: 0,
      message: '로컬 규칙 모드입니다. 키 없이 바로 쓸 수 있습니다.',
      source: null,
    };
  }

  let apiKey: string;
  let source: CredentialSource | null;
  if (preset?.authMode === 'none') {
    // Local server: no key by design — probe with an empty Bearer.
    apiKey = '';
    source = null;
  } else {
    const resolved = await requireApiKey(request.provider, request.presetId, request.apiKey, runtime);
    if (resolved.key === null) {
      return {
        ok: false,
        provider: request.provider,
        model,
        latencyMs: 0,
        message: 'API 키가 없습니다. 키를 입력하거나 데몬 환경변수를 설정해 주세요.',
        source: null,
      };
    }
    apiKey = resolved.key;
    source = resolved.source;
  }

  const probe = await probeProvider({
    provider: request.provider,
    apiKey,
    model,
    endpoint,
    ...(runtime.fetchImpl === undefined ? {} : { fetchImpl: runtime.fetchImpl }),
  });
  return {
    ok: probe.ok,
    provider: request.provider,
    model,
    latencyMs: probe.latencyMs,
    message: probe.message.slice(0, 300),
    source,
  };
}
