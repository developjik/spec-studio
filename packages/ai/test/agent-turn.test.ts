import { describe, expect, it } from 'vitest';
import { ASK_HUMAN_TOOL, type AgentMessage, type AgentToolSpec } from '@spec-studio/protocol';
import { callAgentTurn } from '../src/providers';

/**
 * The multi-turn, tool-carrying half of the provider layer (E3 F1). The
 * single-shot `callModel` keeps its exact signature for the golden set
 * (AC-6); this is the agent's call: messages[], a declared tool whitelist,
 * and tool calls travelling both directions in each provider's own dialect.
 */

const echo: AgentToolSpec = {
  name: 'echo',
  description: 'test double',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
};

const conversation: AgentMessage[] = [
  { role: 'system', text: '리서치 어시스턴트' },
  { role: 'user', text: '아이디어 조사해줘' },
  {
    role: 'assistant',
    text: '',
    toolCalls: [{ id: 't1', name: 'echo', input: { text: 'hi' } }],
  },
  { role: 'tool', toolCallId: 't1', name: 'echo', ok: true, output: '{"echo":"hi"}' },
];

function fakeFetch(handler: (url: string, body: Record<string, unknown>) => unknown): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify(handler(url, body)), { status: 200 });
  }) as typeof fetch;
}

describe('callAgentTurn — OpenAI-compatible', () => {
  const input = {
    provider: 'openai' as const,
    apiKey: 'sk-test',
    model: 'gpt-test',
    messages: conversation,
    tools: [echo, ASK_HUMAN_TOOL],
    fetchImpl: fakeFetch((url, body) => {
      expect(url).toContain('/chat/completions');
      // the conversation crosses in the provider's dialect, tools declared
      expect(body.tools).toEqual([
        { type: 'function', function: { name: 'echo', description: 'test double', parameters: echo.inputSchema } },
        { type: 'function', function: { name: 'ask_human', description: expect.any(String), parameters: expect.anything() } },
      ]);
      const messages = body.messages as Array<{ role: string; content?: unknown; tool_calls?: unknown[] }>;
      expect(messages[0]).toMatchObject({ role: 'system', content: '리서치 어시스턴트' });
      const assistant = messages[2] as { role: string; tool_calls?: Array<{ function: { name: string } }> };
      const toolTurn = messages[3];
      expect(assistant).toMatchObject({ role: 'assistant' });
      expect(assistant.tool_calls?.[0]?.function.name).toBe('echo');
      expect(toolTurn).toMatchObject({ role: 'tool', tool_call_id: 't1' });
      return {
        choices: [
          {
            message: {
              content: '{"action":"final","draft":{}}',
              tool_calls: [
                { id: 't2', type: 'function', function: { name: 'ask_human', arguments: '{"question":"예산?"}' } },
              ],
            },
          },
        ],
      };
    }),
  };

  it('maps the conversation and reads tool calls back', async () => {
    const answer = await callAgentTurn(input);
    expect(answer.text).toBe('{"action":"final","draft":{}}');
    expect(answer.toolCalls).toEqual([{ id: 't2', name: 'ask_human', input: { question: '예산?' } }]);
  });
});

describe('callAgentTurn — Anthropic Messages API', () => {
  it('maps tool_use blocks and tool_result content both ways', async () => {
    const answer = await callAgentTurn({
      provider: 'anthropic',
      apiKey: 'ak-test',
      model: 'claude-test',
      messages: conversation,
      tools: [echo],
      fetchImpl: fakeFetch((url, body) => {
        expect(url).toContain('/v1/messages');
        expect(body.system).toBe('리서치 어시스턴트');
        expect(body.tools).toEqual([{ name: 'echo', description: 'test double', input_schema: echo.inputSchema }]);
        const messages = body.messages as Array<{ role: string; content: unknown }>;
        // the assistant turn carries a tool_use block
        const assistant = messages[1] as { role: string; content: Array<{ type: string }> };
        expect(assistant.content.some((part) => part.type === 'tool_use')).toBe(true);
        // the tool answer is a user turn with a tool_result block
        const toolTurn = messages[2] as { role: string; content: Array<{ type: string; tool_use_id?: string }> };
        expect(toolTurn.role).toBe('user');
        expect(toolTurn.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
        return {
          content: [
            { type: 'text', text: '중간 생각' },
            { type: 'tool_use', id: 't9', name: 'echo', input: { text: 'again' } },
          ],
        };
      }),
    });
    expect(answer.text).toBe('중간 생각');
    expect(answer.toolCalls).toEqual([{ id: 't9', name: 'echo', input: { text: 'again' } }]);
  });
});

describe('callAgentTurn — failures', () => {
  it('throws the provider error vocabulary on HTTP failure', async () => {
    await expect(
      callAgentTurn({
        provider: 'openai',
        apiKey: 'sk-bad',
        model: 'm',
        messages: conversation,
        tools: [],
        fetchImpl: (async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })) as typeof fetch,
      }),
    ).rejects.toThrowError(/키가 거부/);
  });

  it('an abort signal cancels the call honestly', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      callAgentTurn({
        provider: 'openai',
        apiKey: 'sk',
        model: 'm',
        messages: conversation,
        tools: [],
        signal: controller.signal,
        fetchImpl: fakeFetch(() => ({})),
      }),
    ).rejects.toThrowError();
  });
});
