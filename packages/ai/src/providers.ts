import {
  AI_DEFAULT_ENDPOINTS,
  type AgentMessage,
  type AgentToolCall,
  type AgentToolSpec,
  type AiRemoteProvider,
} from '@spec-studio/protocol';

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

export interface AgentTurnInput {
  provider: AiRemoteProvider;
  apiKey: string;
  model: string;
  endpoint?: string | null;
  /** The run's conversation so far (F1 messages[]), system turn included. */
  messages: AgentMessage[];
  /** The declared whitelist for this run — sent as the provider's tool list. */
  tools: AgentToolSpec[];
  maxTokens?: number;
  timeoutMs?: number;
  /** Cancellation (run.cancel): aborts the in-flight request. */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface AgentTurnResult {
  text: string;
  toolCalls: AgentToolCall[];
}

interface AnthropicToolUseBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
}

interface OpenAiToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

function anthropicMessages(messages: AgentMessage[]): Array<{ role: string; content: unknown }> {
  const out: Array<{ role: string; content: unknown }> = [];
  for (const message of messages) {
    if (message.role === 'system') continue; // rides the `system` parameter
    if (message.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: message.text }] });
    } else if (message.role === 'assistant') {
      const content: AnthropicToolUseBlock[] = [];
      if (message.text !== '') content.push({ type: 'text', text: message.text });
      for (const call of message.toolCalls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} });
      }
      out.push({ role: 'assistant', content: content.length === 0 ? [{ type: 'text', text: '' }] : content });
    } else {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: message.output,
            is_error: !message.ok,
          },
        ],
      });
    }
  }
  return out;
}

function openAiMessages(messages: AgentMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'system') {
      out.push({ role: 'system', content: message.text });
    } else if (message.role === 'user') {
      out.push({ role: 'user', content: message.text });
    } else if (message.role === 'assistant') {
      const entry: Record<string, unknown> = { role: 'assistant', content: message.text };
      if (message.toolCalls.length > 0) {
        entry.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
        }));
      }
      out.push(entry);
    } else {
      out.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.output,
      });
    }
  }
  return out;
}

function parseOpenAiToolCalls(calls: OpenAiToolCall[] | undefined): AgentToolCall[] {
  if (calls === undefined) return [];
  const out: AgentToolCall[] = [];
  for (const call of calls) {
    if (call.id === undefined || call.function?.name === undefined) continue;
    let input: unknown = {};
    try {
      input = call.function.arguments === undefined ? {} : JSON.parse(call.function.arguments);
    } catch {
      input = {};
    }
    out.push({ id: call.id, name: call.function.name, input });
  }
  return out;
}

/**
 * The agent's provider call (E3 F1): multi-turn with a declared tool list.
 * The single-shot `callModel` above keeps its exact signature — the golden
 * set's path (AC-6) never changes shape.
 */
export async function callAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = endpointFor(input.provider, input.endpoint);
  const maxTokens = input.maxTokens ?? 2048;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let body: Record<string, unknown>;
  const system = input.messages
    .filter((message): message is Extract<AgentMessage, { role: 'system' }> => message.role === 'system')
    .map((message) => message.text)
    .join('\n\n');

  if (input.provider === 'anthropic') {
    headers['x-api-key'] = input.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model: input.model,
      max_tokens: maxTokens,
      temperature: 0,
      system,
      messages: anthropicMessages(input.messages),
      tools: input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
    };
  } else {
    headers.authorization = `Bearer ${input.apiKey}`;
    body = {
      model: input.model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: openAiMessages(input.messages),
      ...(input.tools.length === 0
        ? {}
        : {
            tools: input.tools.map((tool) => ({
              type: 'function',
              function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
            })),
          }),
    };
  }

  const timeout = AbortSignal.timeout(input.timeoutMs ?? 120_000);
  const signal = input.signal === undefined ? timeout : AbortSignal.any([timeout, input.signal]);

  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (input.signal?.aborted) throw new AiProviderError('network', `런이 취소되어 요청을 중단했습니다`);
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

  if (input.provider === 'anthropic') {
    const blocks = (parsed.content ?? []) as AnthropicToolUseBlock[];
    const text = blocks
      .filter((part) => part.type === undefined || part.type === 'text')
      .map((part) => part.text ?? '')
      .join('');
    const toolCalls = blocks
      .filter((part) => part.type === 'tool_use' && part.id !== undefined && part.name !== undefined)
      .map((part) => ({ id: part.id as string, name: part.name as string, input: part.input ?? {} }));
    if (text.trim() === '' && toolCalls.length === 0) {
      throw new AiProviderError('empty_response', AUTH_MESSAGE.empty_response, response.status);
    }
    return { text, toolCalls };
  }

  const message = parsed.choices?.[0]?.message;
  const text = textOfOpenAiMessage(message?.content);
  const toolCalls = parseOpenAiToolCalls(
    (message as { tool_calls?: OpenAiToolCall[] } | undefined)?.tool_calls,
  );
  if (text.trim() === '' && toolCalls.length === 0) {
    throw new AiProviderError('empty_response', AUTH_MESSAGE.empty_response, response.status);
  }
  return { text, toolCalls };
}

/** One SSE block boundary — tolerates both LF and CRLF framing. */
function sseBlockEnd(buffer: string): { at: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1) return crlf === -1 ? null : { at: crlf, length: 4 };
  if (crlf === -1 || lf < crlf) return { at: lf, length: 2 };
  return { at: crlf, length: 4 };
}

/** Yields each `data:` payload of a server-sent-event body as parsed JSON. */
async function* sseJson(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut = sseBlockEnd(buffer);
      while (cut !== null) {
        const block = buffer.slice(0, cut.at);
        buffer = buffer.slice(cut.at + cut.length);
        for (const line of block.split('\n')) {
          const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '' || payload === '[DONE]') continue;
          try {
            yield JSON.parse(payload) as Record<string, unknown>;
          } catch {
            // a data line that is not JSON is not our event — skip it
          }
        }
        cut = sseBlockEnd(buffer);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

interface StreamToolCall {
  id: string;
  name: string;
  args: string;
}

function finishStreamCalls(blocks: Map<number, StreamToolCall>): AgentToolCall[] {
  const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]);
  const toolCalls: AgentToolCall[] = [];
  for (const [, call] of ordered) {
    if (call.id === '' || call.name === '') continue;
    let input: unknown = {};
    try {
      input = call.args === '' ? {} : JSON.parse(call.args);
    } catch {
      input = {};
    }
    toolCalls.push({ id: call.id, name: call.name, input });
  }
  return toolCalls;
}

/** Anthropic Messages SSE: text_delta events, tool_use assembled by index. */
async function readAnthropicStream(
  body: ReadableStream<Uint8Array>,
  onText: ((delta: string) => void) | undefined,
): Promise<AgentTurnResult> {
  let text = '';
  const blocks = new Map<number, StreamToolCall>();
  for await (const event of sseJson(body)) {
    if (event.type === 'content_block_start') {
      const block = event.content_block as { type?: string; id?: string; name?: string } | undefined;
      const index = typeof event.index === 'number' ? event.index : blocks.size;
      if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        blocks.set(index, { id: block.id, name: block.name, args: '' });
      }
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta as { type?: string; text?: string; partial_json?: string } | undefined;
      const index = typeof event.index === 'number' ? event.index : 0;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
        text += delta.text;
        onText?.(delta.text);
      } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const call = blocks.get(index);
        if (call !== undefined) call.args += delta.partial_json;
      }
    } else if (event.type === 'error') {
      const apiError = event.error as { message?: string } | undefined;
      throw new AiProviderError(
        'http_error',
        `${AUTH_MESSAGE.http_error} (${apiError?.message ?? 'stream error'})`,
      );
    }
  }
  const toolCalls = finishStreamCalls(blocks);
  if (text.trim() === '' && toolCalls.length === 0) {
    throw new AiProviderError('empty_response', AUTH_MESSAGE.empty_response);
  }
  return { text, toolCalls };
}

/** OpenAI chat SSE: content deltas, tool_calls accumulated by index. */
async function readOpenAiStream(
  body: ReadableStream<Uint8Array>,
  onText: ((delta: string) => void) | undefined,
): Promise<AgentTurnResult> {
  let text = '';
  const blocks = new Map<number, StreamToolCall>();
  for await (const chunk of sseJson(body)) {
    const choices = chunk.choices as
      | Array<{
          delta?: {
            content?: string | null;
            tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
          };
        }>
      | undefined;
    const delta = choices?.[0]?.delta;
    if (typeof delta?.content === 'string' && delta.content !== '') {
      text += delta.content;
      onText?.(delta.content);
    }
    for (const call of delta?.tool_calls ?? []) {
      const index = typeof call.index === 'number' ? call.index : 0;
      const acc = blocks.get(index) ?? { id: '', name: '', args: '' };
      if (typeof call.id === 'string') acc.id = call.id;
      if (typeof call.function?.name === 'string') acc.name = call.function.name;
      if (typeof call.function?.arguments === 'string') acc.args += call.function.arguments;
      blocks.set(index, acc);
    }
  }
  const toolCalls = finishStreamCalls(blocks);
  if (text.trim() === '' && toolCalls.length === 0) {
    throw new AiProviderError('empty_response', AUTH_MESSAGE.empty_response);
  }
  return { text, toolCalls };
}

/**
 * The streaming twin of `callAgentTurn` (E3 W2 · AC-9): same request body plus
 * `stream: true`, text deltas forwarded to `onText` as they arrive, and the
 * same {text, toolCalls} result assembled at the end. The one-shot callModel
 * below is untouched — the golden set's path keeps its shape (AC-6).
 */
export async function callModelStream(
  input: AgentTurnInput,
  onText?: (delta: string) => void,
): Promise<AgentTurnResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = endpointFor(input.provider, input.endpoint);
  const maxTokens = input.maxTokens ?? 2048;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let body: Record<string, unknown>;
  const system = input.messages
    .filter((message): message is Extract<AgentMessage, { role: 'system' }> => message.role === 'system')
    .map((message) => message.text)
    .join('\n\n');

  if (input.provider === 'anthropic') {
    headers['x-api-key'] = input.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model: input.model,
      max_tokens: maxTokens,
      temperature: 0,
      stream: true,
      system,
      messages: anthropicMessages(input.messages),
      tools: input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
    };
  } else {
    headers.authorization = `Bearer ${input.apiKey}`;
    body = {
      model: input.model,
      temperature: 0,
      max_tokens: maxTokens,
      stream: true,
      messages: openAiMessages(input.messages),
      ...(input.tools.length === 0
        ? {}
        : {
            tools: input.tools.map((tool) => ({
              type: 'function',
              function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
            })),
          }),
    };
  }

  const timeout = AbortSignal.timeout(input.timeoutMs ?? 120_000);
  const signal = input.signal === undefined ? timeout : AbortSignal.any([timeout, input.signal]);

  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (input.signal?.aborted) throw new AiProviderError('network', `런이 취소되어 요청을 중단했습니다`);
    throw new AiProviderError('network', `${AUTH_MESSAGE.network} (${redact(detail, input.apiKey).slice(0, 160)})`);
  }

  if (!response.ok) {
    const raw = await response.text();
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

  if (response.body === null) {
    throw new AiProviderError('empty_response', AUTH_MESSAGE.empty_response, response.status);
  }

  try {
    return input.provider === 'anthropic'
      ? await readAnthropicStream(response.body, onText)
      : await readOpenAiStream(response.body, onText);
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    if (input.signal?.aborted) throw new AiProviderError('network', `런이 취소되어 요청을 중단했습니다`);
    const detail = error instanceof Error ? error.message : String(error);
    throw new AiProviderError('network', `${AUTH_MESSAGE.network} (${redact(detail, input.apiKey).slice(0, 160)})`);
  }
}

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
