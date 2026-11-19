import { AI_DEFAULT_ENDPOINTS, type AiRemoteProvider } from '@spec-studio/protocol';

/**
 * The two provider calls, and nothing else.
 *
 * Both are plain `fetch` against an HTTP API: no SDK, so the daemon stays a
 * small bundle and a custom base URL (a local model server, a gateway, a test
 * double) is the same code path as the vendor's. The key is read from the
 * argument, put in a header, and forgotten — it is never stored, logged, or
 * echoed back in an error message.
 */

export interface ModelCallInput {
  provider: AiRemoteProvider;
  apiKey: string;
  model: string;
  /** Custom base URL; `null`/omitted uses the provider default. */
  endpoint?: string | null;
  system: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Injected in tests; production uses the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ModelCallResult {
  provider: AiRemoteProvider;
  model: string;
  text: string;
  latencyMs: number;
}

export type AiProviderErrorCode = 'auth' | 'rate_limited' | 'http_error' | 'network' | 'empty_response';

export class AiProviderError extends Error {
  readonly code: AiProviderErrorCode;
  readonly status: number | null;

  constructor(code: AiProviderErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'AiProviderError';
    this.code = code;
    this.status = status;
  }
}

/** Removes a key from text before it can reach a message, a log or a screen. */
export function redact(text: string, secret: string): string {
  if (secret === '') return text;
  return text.split(secret).join('[redacted]');
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.endsWith(path) ? trimmed : `${trimmed}${path}`;
}

function endpointFor(provider: AiRemoteProvider, endpoint: string | null | undefined): string {
  const base = endpoint === undefined || endpoint === null || endpoint.trim() === ''
    ? AI_DEFAULT_ENDPOINTS[provider]
    : endpoint.trim();
  return provider === 'anthropic' ? joinUrl(base, '/v1/messages') : joinUrl(base, '/chat/completions');
}

interface AnthropicBody {
  content?: Array<{ type?: string; text?: string }>;
  error?: { type?: string; message?: string };
}

interface OpenAiBody {
  choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  error?: { message?: string };
}

function textOfOpenAiMessage(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part.type === undefined || part.type === 'text' ? (part.text ?? '') : ''))
    .join('');
}

function statusCode(code: AiProviderErrorCode, status: number): AiProviderErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  return code;
}

const AUTH_MESSAGE: Record<AiProviderErrorCode, string> = {
  auth: 'API 키가 거부되었습니다. 키와 프로바이더를 확인해 주세요.',
  rate_limited: '요청 한도에 걸렸습니다. 잠시 뒤 다시 시도해 주세요.',
  http_error: '모델 서버가 오류를 돌려주었습니다.',
  network: '모델 서버에 연결하지 못했습니다. Endpoint와 네트워크를 확인해 주세요.',
  empty_response: '모델이 빈 응답을 돌려주었습니다.',
};

export async function callModel(input: ModelCallInput): Promise<ModelCallResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = endpointFor(input.provider, input.endpoint);
  const maxTokens = input.maxTokens ?? 2048;
  const started = Date.now();

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let body: Record<string, unknown>;
  if (input.provider === 'anthropic') {
    headers['x-api-key'] = input.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model: input.model,
      max_tokens: maxTokens,
      temperature: 0,
      system: input.system,
      messages: [{ role: 'user', content: input.prompt }],
    };
  } else {
    headers.authorization = `Bearer ${input.apiKey}`;
    body = {
      model: input.model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.prompt },
      ],
    };
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AiProviderError('network', `${AUTH_MESSAGE.network} (${redact(detail, input.apiKey).slice(0, 160)})`);
  }

  const raw = await response.text();
  if (!response.ok) {
    let apiMessage = '';
    try {
      const parsed = JSON.parse(raw) as AnthropicBody & OpenAiBody;
      apiMessage = parsed.error?.message ?? '';
    } catch {
      apiMessage = raw.slice(0, 200);
    }
    const code = statusCode('http_error', response.status);
    throw new AiProviderError(
      code,
      `${AUTH_MESSAGE[code]} (${input.provider} ${response.status}${apiMessage === '' ? '' : ` · ${redact(apiMessage, input.apiKey).slice(0, 160)}`})`,
      response.status,
    );
  }

  let parsed: AnthropicBody & OpenAiBody;
  try {
    parsed = JSON.parse(raw) as AnthropicBody & OpenAiBody;
  } catch {
    throw new AiProviderError('empty_response', '모델 응답이 JSON이 아닙니다.', response.status);
  }

  const text =
    input.provider === 'anthropic'
      ? (parsed.content ?? [])
          .filter((part) => part.type === undefined || part.type === 'text')
          .map((part) => part.text ?? '')
          .join('')
      : textOfOpenAiMessage(parsed.choices?.[0]?.message?.content);

  if (text.trim() === '') {
    throw new AiProviderError('empty_response', AUTH_MESSAGE.empty_response, response.status);
  }

  return {
    provider: input.provider,
    model: input.model,
    text,
    latencyMs: Date.now() - started,
  };
}
