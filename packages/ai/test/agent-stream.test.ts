import { describe, expect, it } from 'vitest';
import { ASK_HUMAN_TOOL, type AgentMessage, type AgentToolSpec } from '@spec-studio/protocol';
import { callModelStream } from '../src/providers';

/**
 * The streaming twin's contract (E3 W2 · AC-9): the request body is the agent
 * call plus `stream: true`; text deltas reach `onText` as they arrive; the
 * assembled answer is the same {text, toolCalls} the one-shot path returns.
 * `callModel` keeps its exact signature — this suite never touches it.
 */

const echo: AgentToolSpec = {
  name: 'echo',
  description: 'test double',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
};

const conversation: AgentMessage[] = [
  { role: 'system', text: '리서치 어시스턴트' },
  { role: 'user', text: '아이디어 조사해줘' },
];

function sseFetch(body: string, assert?: (request: Record<string, unknown>) => void): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    assert?.(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

const anthropicSse = [
  'data: {"type":"message_start","message":{"id":"msg_1","role":"assistant"}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"조사 "}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"진행 중"}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"ask_human","input":{}}}',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"question\\":"}}',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"예산은?\\"}"}}',
  'data: {"type":"content_block_stop","index":1}',
  'data: {"type":"message_stop"}',
  '',
].join('\n\n');

const openAiSse = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"조사 "}}]}',
  'data: {"choices":[{"index":0,"delta":{"content":"진행 중"}}]}',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"t2","type":"function","function":{"name":"ask_human","arguments":"{\\"question\\":"}}]}}]}',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"예산은?\\"}"}}]}}]}',
  'data: [DONE]',
  '',
].join('\n\n');

describe('callModelStream — Anthropic Messages API', () => {
  it('streams text deltas and assembles tool_use from partial JSON', async () => {
    const deltas: string[] = [];
    const answer = await callModelStream(
      {
        provider: 'anthropic',
        apiKey: 'ak-test',
        model: 'claude-test',
        messages: conversation,
        tools: [ASK_HUMAN_TOOL],
        fetchImpl: sseFetch(anthropicSse, (request) => {
          expect(request.stream).toBe(true);
          expect(request.system).toBe('리서치 어시스턴트');
        }),
      },
      (delta) => deltas.push(delta),
    );
    expect(deltas).toEqual(['조사 ', '진행 중']);
    expect(answer.text).toBe('조사 진행 중');
    expect(answer.toolCalls).toEqual([{ id: 't1', name: 'ask_human', input: { question: '예산은?' } }]);
  });
});

describe('callModelStream — OpenAI-compatible', () => {
  it('streams content deltas and assembles tool_calls fragments', async () => {
    const deltas: string[] = [];
    const answer = await callModelStream(
      {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-test',
        messages: conversation,
        tools: [echo, ASK_HUMAN_TOOL],
        fetchImpl: sseFetch(openAiSse, (request) => {
          expect(request.stream).toBe(true);
          expect((request.tools as unknown[]).length).toBe(2);
        }),
      },
      (delta) => deltas.push(delta),
    );
    expect(deltas).toEqual(['조사 ', '진행 중']);
    expect(answer.text).toBe('조사 진행 중');
    expect(answer.toolCalls).toEqual([{ id: 't2', name: 'ask_human', input: { question: '예산은?' } }]);
  });
});

describe('callModelStream — failures keep the provider vocabulary', () => {
  it('an HTTP error is the same refusal the one-shot path gives', async () => {
    await expect(
      callModelStream({
        provider: 'openai',
        apiKey: 'sk-bad',
        model: 'm',
        messages: conversation,
        tools: [],
        fetchImpl: (async () =>
          new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })) as typeof fetch,
      }),
    ).rejects.toThrowError(/키가 거부/);
  });

  it('an empty stream is empty_response, not a silent nothing', async () => {
    await expect(
      callModelStream({
        provider: 'openai',
        apiKey: 'sk',
        model: 'm',
        messages: conversation,
        tools: [],
        fetchImpl: sseFetch('data: [DONE]\n\n'),
      }),
    ).rejects.toThrowError(/빈 응답/);
  });

  it('an abort mid-request cancels honestly', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      callModelStream({
        provider: 'openai',
        apiKey: 'sk',
        model: 'm',
        messages: conversation,
        tools: [],
        signal: controller.signal,
        fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          // a real fetch refuses an already-aborted signal — the double does too
          if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
          return new Response(openAiSse, { status: 200 });
        }) as typeof fetch,
      }),
    ).rejects.toThrowError();
  });
});
