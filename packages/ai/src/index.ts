import {
  type AiProvider,
  type AiRemoteProvider,
  type CredentialPort,
  type CredentialSource,
} from '@spec-studio/protocol';
import { AiProviderError, callModel, redact } from './providers.js';
import { buildBriefPrompt, buildDocPrompt, buildGraphPrompt, buildProbePrompt, buildSystemPrompt } from './prompt.js';
import { AiDraftError, extractJsonObject, parseBriefDraft, parseDocDraft, parseGraphDraft } from './parse.js';
import type { BriefInput } from './brief.js';
import {
  EnvCredentialPort,
  RequestCredentialPort,
  resolveCredentials,
} from './credentials.js';

export {
  AiProviderError,
  callAgentTurn,
  callModel,
  redact,
  type AgentTurnInput,
  type AgentTurnResult,
  type AiProviderErrorCode,
  type ModelCallInput,
  type ModelCallResult,
} from './providers.js';
export {
  buildBriefPrompt,
  buildDocPrompt,
  buildGraphPrompt,
  buildProbePrompt,
  buildSystemPrompt,
} from './prompt.js';
export {
  AiDraftError,
  extractJsonObject,
  parseBriefDraft,
  parseDocDraft,
  parseGraphDraft,
} from './parse.js';
export { buildFallbackBrief, selectedEvidence, BRIEF_MAX_EVIDENCE, type BriefInput } from './brief.js';
export { EnvCredentialPort, RequestCredentialPort, resolveCredentials } from './credentials.js';
export type { CredentialPort, CredentialSource } from '@spec-studio/protocol';

/**
 * The key a request will use: the one in the body first, then the OS keychain
 * (when the daemon has one), then the daemon's environment. Nothing else — no
 * file, no database row, no settings screen that survives a reload. `null`
 * means "no key anywhere", which is the honest answer the UI needs to offer
 * the local rule extractor instead. `local` never has a key.
 */
export async function resolveApiKey(
  provider: AiProvider,
  presetId: string | undefined,
  requestKey: string | null | undefined,
  env: Record<string, string | undefined>,
  keychain?: CredentialPort | null,
): Promise<{ key: string | null; source: CredentialSource | null }> {
  if (!isRemote(provider)) return { key: null, source: null };
  return resolveCredentials(
    [
      new RequestCredentialPort(requestKey),
      ...(keychain == null ? [] : [keychain]),
      new EnvCredentialPort(env),
    ],
    provider,
    presetId,
  );
}

export function isRemote(provider: AiProvider): provider is AiRemoteProvider {
  return provider === 'anthropic' || provider === 'openai';
}

/** One call, whatever the mode: build the prompt, ask, parse the draft. */
export async function requestGraphDraft(input: {
  provider: AiRemoteProvider;
  apiKey: string;
  model: string;
  endpoint?: string | null;
  project: Parameters<typeof buildGraphPrompt>[0];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}) {
  const result = await callModel({
    provider: input.provider,
    apiKey: input.apiKey,
    model: input.model,
    endpoint: input.endpoint ?? null,
    system: buildSystemPrompt('graph'),
    prompt: buildGraphPrompt(input.project),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  return { draft: parseGraphDraft(result.text), text: result.text, latencyMs: result.latencyMs };
}

export async function requestDocDraft(input: {
  provider: AiRemoteProvider;
  apiKey: string;
  model: string;
  endpoint?: string | null;
  project: Parameters<typeof buildDocPrompt>[0];
  docId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}) {
  const prompt = buildDocPrompt(input.project, input.docId);
  if (prompt === '') {
    throw new AiDraftError('이 프로젝트에는 제안할 문서가 없습니다.');
  }
  const result = await callModel({
    provider: input.provider,
    apiKey: input.apiKey,
    model: input.model,
    endpoint: input.endpoint ?? null,
    system: buildSystemPrompt('doc'),
    prompt,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  return { draft: parseDocDraft(result.text), text: result.text, latencyMs: result.latencyMs };
}

export async function requestBriefDraft(input: {
  provider: AiRemoteProvider;
  apiKey: string;
  model: string;
  endpoint?: string | null;
  project: Parameters<typeof buildBriefPrompt>[0];
  brief?: BriefInput;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}) {
  const result = await callModel({
    provider: input.provider,
    apiKey: input.apiKey,
    model: input.model,
    endpoint: input.endpoint ?? null,
    system: buildSystemPrompt('brief'),
    prompt: buildBriefPrompt(input.project, input.brief ?? {}),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  return { draft: parseBriefDraft(result.text), text: result.text, latencyMs: result.latencyMs };
}

/** A cheap probe for the settings panel's connection badge. */
export async function probeProvider(input: {
  provider: AiRemoteProvider;
  apiKey: string;
  model: string;
  endpoint?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ ok: boolean; latencyMs: number; message: string }> {
  const probe = buildProbePrompt();
  try {
    const result = await callModel({
      provider: input.provider,
      apiKey: input.apiKey,
      model: input.model,
      endpoint: input.endpoint ?? null,
      system: probe.system,
      prompt: probe.prompt,
      maxTokens: 32,
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    // Any JSON object back means the endpoint, key and model are usable.
    extractJsonObject(result.text);
    return { ok: true, latencyMs: result.latencyMs, message: '연결되었습니다.' };
  } catch (error) {
    const message =
      error instanceof AiProviderError
        ? redact(error.message, input.apiKey)
        : error instanceof Error
          ? redact(error.message, input.apiKey)
          : '연결하지 못했습니다.';
    return { ok: false, latencyMs: 0, message };
  }
}
