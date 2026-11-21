import { AI_DEFAULT_ENDPOINTS, AI_ENV_KEYS, type AiProvider, type AiRemoteProvider } from '@spec-studio/protocol';
import { AiProviderError, callModel, redact } from './providers.js';
import { buildDocPrompt, buildGraphPrompt, buildProbePrompt, buildSystemPrompt } from './prompt.js';
import { AiDraftError, extractJsonObject, parseDocDraft, parseGraphDraft } from './parse.js';

export {
  AiProviderError,
  callModel,
  redact,
  type AiProviderErrorCode,
  type ModelCallInput,
  type ModelCallResult,
} from './providers.js';
export {
  buildDocPrompt,
  buildGraphPrompt,
  buildProbePrompt,
  buildSystemPrompt,
} from './prompt.js';
export { AiDraftError, extractJsonObject, parseDocDraft, parseGraphDraft } from './parse.js';

/**
 * Whether `endpoint` is the provider's own host, which is the only place the
 * daemon's environment key may be spent.
 *
 * An empty endpoint means "the default", so it counts as official. A custom
 * endpoint does not: a request body is attacker-shaped input when a page on any
 * origin can reach the loopback API, and sending `ANTHROPIC_API_KEY` to a host
 * the body chose would hand the key to whoever wrote the body. Comparing the
 * whole host also catches the obvious spoofs (`api.anthropic.com.evil.example`,
 * `https://api.anthropic.com@evil.example`) because the URL parser reports the
 * host that will actually be dialled.
 */
export function isOfficialEndpoint(
  provider: AiRemoteProvider,
  endpoint: string | null | undefined,
): boolean {
  if (endpoint === null || endpoint === undefined || endpoint.trim() === '') return true;
  try {
    const given = new URL(endpoint.trim());
    const official = new URL(AI_DEFAULT_ENDPOINTS[provider]);
    return given.protocol === 'https:' && given.host === official.host;
  } catch {
    return false;
  }
}

/**
 * The key a request will use: the one in the body first, then the daemon's
 * environment — but the environment key only against the provider's own host.
 * Nothing else: no file, no database row, no settings screen that survives a
 * reload. `null` means "no key this request may use", which is the honest
 * answer the UI needs to offer the local rule extractor instead.
 */
export function resolveApiKey(
  provider: AiProvider,
  requestKey: string | null | undefined,
  env: Record<string, string | undefined>,
  endpoint: string | null | undefined = null,
): string | null {
  if (provider === 'local') return null;
  const trimmed = (requestKey ?? '').trim();
  if (trimmed !== '') return trimmed;
  if (!isOfficialEndpoint(provider, endpoint)) return null;
  const fromEnv = (env[AI_ENV_KEYS[provider]] ?? '').trim();
  return fromEnv === '' ? null : fromEnv;
}

/** Whether the daemon holds a key for this provider at all — never the key. */
export function hasEnvKey(
  provider: AiProvider,
  env: Record<string, string | undefined>,
): boolean {
  if (provider === 'local') return false;
  return (env[AI_ENV_KEYS[provider]] ?? '').trim() !== '';
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
