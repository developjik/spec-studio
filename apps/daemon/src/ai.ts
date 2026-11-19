import {
  AI_DEFAULT_ENDPOINTS,
  AI_DEFAULT_MODELS,
  AI_ENV_KEYS,
  AI_PROVIDERS,
  AiProposalRequestSchema,
  type AiProvider,
  type AiProposalRequest,
  type AiProposalSource,
  type AiStatus,
  type AiTestResult,
  type Command,
  type Project,
  type Project as ProjectType,
} from '@spec-studio/protocol';
import {
  AiDraftError,
  AiProviderError,
  isRemote,
  probeProvider,
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
}

export interface AiCommandPlan {
  command: Command;
  source: AiProposalSource;
  provider: AiProvider;
  model: string;
  note: string;
}

export function aiStatus(env: Record<string, string | undefined>): AiStatus {
  return {
    providers: AI_PROVIDERS.map((provider) => ({
      provider,
      hasEnvKey:
        provider !== 'local' && (env[AI_ENV_KEYS[provider]] ?? '').trim() !== '',
      defaultModel: AI_DEFAULT_MODELS[provider],
      defaultEndpoint: provider === 'local' ? null : AI_DEFAULT_ENDPOINTS[provider],
    })),
    localAvailable: true,
  };
}

function requireApiKey(provider: AiProvider, requestKey: string | null | undefined, env: AiRuntime['env']): string | null {
  return resolveApiKey(provider, requestKey, env);
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
  const doc = project.doc;
  if (doc === null || (request.docId !== undefined && doc.id !== request.docId)) {
    throw new DomainError('doc_missing', '제안할 문서가 없습니다. 먼저 문서를 만들어 주세요.');
  }
  return {
    command: { type: 'proposal.create', docId: doc.id },
    source: 'rule',
    provider: 'local',
    model: '',
    note: why,
  };
}

/** Turns one browser request into the command the store will run. */
export async function planAiProposal(
  project: ProjectType,
  raw: unknown,
  runtime: AiRuntime,
): Promise<AiCommandPlan> {
  const request = AiProposalRequestSchema.parse(raw);
  const model =
    request.model.trim() === '' ? AI_DEFAULT_MODELS[request.provider] : request.model.trim();

  if (!isRemote(request.provider)) {
    return localPlan(project, request, '로컬 규칙으로 만들었습니다. API 키는 쓰지 않았습니다.');
  }

  const apiKey = requireApiKey(request.provider, request.apiKey, runtime.env);
  if (apiKey === null) {
    return localPlan(
      project,
      request,
      'API 키가 없어 로컬 규칙으로 만들었습니다. 키를 넣으면 LLM 제안을 씁니다.',
    );
  }
  if (model === '') {
    throw new AiRequestError(400, 'model_required', '모델 이름을 입력해 주세요.');
  }

  const endpoint = request.endpoint ?? null;
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

    const doc = project.doc;
    if (doc === null || (request.docId !== undefined && doc.id !== request.docId)) {
      throw new DomainError('doc_missing', '제안할 문서가 없습니다. 먼저 문서를 만들어 주세요.');
    }
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
  }).parse(raw);
  const model =
    request.model.trim() === '' ? AI_DEFAULT_MODELS[request.provider] : request.model.trim();

  if (!isRemote(request.provider)) {
    return {
      ok: true,
      provider: 'local',
      model: '',
      latencyMs: 0,
      message: '로컬 규칙 모드입니다. 키 없이 바로 쓸 수 있습니다.',
    };
  }

  const apiKey = requireApiKey(request.provider, request.apiKey, runtime.env);
  if (apiKey === null) {
    return {
      ok: false,
      provider: request.provider,
      model,
      latencyMs: 0,
      message: 'API 키가 없습니다. 키를 입력하거나 데몬 환경변수를 설정해 주세요.',
    };
  }

  const probe = await probeProvider({
    provider: request.provider,
    apiKey,
    model,
    endpoint: request.endpoint ?? null,
    ...(runtime.fetchImpl === undefined ? {} : { fetchImpl: runtime.fetchImpl }),
  });
  return {
    ok: probe.ok,
    provider: request.provider,
    model,
    latencyMs: probe.latencyMs,
    message: probe.message.slice(0, 300),
  };
}
