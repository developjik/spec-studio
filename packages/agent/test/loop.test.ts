import { describe, expect, it } from 'vitest';
import { ASK_HUMAN_TOOL, type AgentMessage, type AgentToolCall, type AgentToolSpec } from '@spec-studio/protocol';
import { driveRun, type JournalLine, type ModelPort, type ToolBox } from '../src/loop';

/**
 * The runner's four contracts (W1 gates):
 *  - AC-4: a call to a tool the whitelist does not declare is blocked,
 *    journaled, and never executed.
 *  - AC-2 ask: ask_human parks the run as needs_input with the question.
 *  - AC-2 cancel: once cancelled, not one further model call or tool call
 *    happens (후속 0).
 *  - the final turn yields the brief draft the card is built from.
 */

const echoTool: AgentToolSpec = {
  name: 'echo',
  description: 'test double',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
};

function scriptedModel(turns: Array<{ text?: string; toolCalls?: AgentToolCall[] }>): ModelPort & {
  calls: number;
} {
  let index = 0;
  const port: ModelPort & { calls: number } = {
    calls: 0,
    async turn(request) {
      port.calls += 1;
      const turn = turns[Math.min(index, turns.length - 1)] ?? { text: '' };
      index += 1;
      if (request.signal?.aborted) throw new Error('aborted');
      return { text: turn.text ?? '', toolCalls: turn.toolCalls ?? [] };
    },
  };
  return port;
}

function toolbox(tools: AgentToolSpec[], executed: string[] = []): ToolBox {
  return {
    specs: () => tools,
    async execute(call) {
      executed.push(call.name);
      if (call.name === 'ask_human') {
        const input = call.input as { question?: string };
        return { ok: true, output: JSON.stringify({ asked: true, question: input?.question ?? '' }) };
      }
      return { ok: true, output: JSON.stringify(call.input ?? {}) };
    },
  };
}

function journal(lines: JournalLine[] = []) {
  return {
    lines,
    log(stream: JournalLine['stream'], line: string) {
      lines.push({ stream, line });
    },
  };
}

const start: AgentMessage[] = [{ role: 'system', text: 'system' }, { role: 'user', text: '아이디어 조사해줘' }];

describe('run driver — happy paths', () => {
  it('executes a declared tool, feeds the result back, and ends with a final draft', async () => {
    const model = scriptedModel([
      { toolCalls: [{ id: 't1', name: 'echo', input: { text: 'hi' } }] },
      { text: '{"action":"final","draft":{"title":"t","summary":"s","claims":[{"text":"c","ungrounded":true}]}}' },
    ]);
    const executed: string[] = [];
    const j = journal();
    const outcome = await driveRun({
      messages: [...start],
      model,
      toolbox: toolbox([ASK_HUMAN_TOOL, echoTool], executed),
      journal: j,
      isCancelled: async () => false,
      maxTurns: 6,
    });
    expect(outcome.kind).toBe('final');
    if (outcome.kind === 'final') {
      expect((outcome.draft as { title?: string }).title).toBe('t');
    }
    expect(executed).toEqual(['echo']);
    // the conversation the model saw on turn 2 carries the tool result
    expect(model.calls).toBe(2);
  });

  it('ask_human parks the run with the question (AC-2)', async () => {
    const model = scriptedModel([
      { toolCalls: [{ id: 't1', name: 'ask_human', input: { question: '예산은 얼마까지?' } }] },
    ]);
    const j = journal();
    const outcome = await driveRun({
      messages: [...start],
      model,
      toolbox: toolbox([ASK_HUMAN_TOOL]),
      journal: j,
      isCancelled: async () => false,
      maxTurns: 6,
    });
    expect(outcome).toMatchObject({ kind: 'needs_input', question: '예산은 얼마까지?' });
  });
});

describe('run driver — the wall (AC-4 · AC-2)', () => {
  it('blocks an undeclared tool: journaled, answered to the model, never executed', async () => {
    const model = scriptedModel([
      { toolCalls: [{ id: 't1', name: 'rm_rf', input: {} }] },
      { text: '{"action":"final","draft":{"title":"t","summary":"s","claims":[{"text":"c","ungrounded":true}]}}' },
    ]);
    const executed: string[] = [];
    const j = journal();
    const outcome = await driveRun({
      messages: [...start],
      model,
      toolbox: toolbox([ASK_HUMAN_TOOL, echoTool], executed),
      journal: j,
      isCancelled: async () => false,
      maxTurns: 6,
    });
    expect(outcome.kind).toBe('final');
    expect(executed).toEqual([]); // nothing ran
    const blocked = j.lines.find((line) => line.line.includes('rm_rf') && line.line.includes('blocked'));
    expect(blocked).toBeDefined(); // the wall left a record (AC-4)
  });

  it('stops mid-flight on cancel: the in-flight tool may finish, but zero calls follow (후속 0)', async () => {
    let modelCalls = 0;
    let cancelled = false;
    const model: ModelPort = {
      async turn(request) {
        if (request.signal?.aborted) throw new Error('aborted');
        modelCalls += 1;
        if (modelCalls === 1) {
          // two calls in one turn; cancel lands while the first is in flight,
          // so the second must never execute — and no second model turn may
          // happen either.
          return {
            text: '',
            toolCalls: [
              { id: 't1', name: 'echo', input: {} },
              { id: 't2', name: 'echo', input: {} },
            ],
          };
        }
        throw new Error('no second model call may happen after cancel');
      },
    };
    const executed: string[] = [];
    const j = journal();
    const outcome = await driveRun({
      messages: [...start],
      model,
      toolbox: {
        specs: () => [echoTool],
        async execute(call, signal) {
          if (call.id === 't1') {
            // cancel lands while this tool is in flight
            cancelled = true;
            if (signal?.aborted) throw new Error('aborted');
          }
          if (cancelled && call.id === 't2') throw new Error('t2 must never execute');
          executed.push(call.name);
          return { ok: true, output: '{}' };
        },
      },
      journal: j,
      isCancelled: async () => cancelled,
      maxTurns: 6,
    });
    expect(outcome.kind).toBe('cancelled');
    expect(modelCalls).toBe(1);
    expect(executed).toEqual(['echo']); // the in-flight call only — its follow-up never ran
  });

  it('fails honestly when the model never answers within its turns', async () => {
    const model = scriptedModel([{ text: '그냥 대화' }, { text: '또 대화' }]);
    const j = journal();
    const outcome = await driveRun({
      messages: [...start],
      model,
      toolbox: toolbox([]),
      journal: j,
      isCancelled: async () => false,
      maxTurns: 2,
    });
    expect(outcome.kind).toBe('failed');
  });
});

describe('run driver — streaming progress (W2 · AC-9)', () => {
  it('forwards DriveOptions.onText to the model turn each round', async () => {
    const seen: string[] = [];
    const model: ModelPort = {
      async turn(request) {
        request.onText?.('델타 ');
        request.onText?.('조각');
        return { text: '{"action":"final","draft":{}}', toolCalls: [] };
      },
    };
    const outcome = await driveRun({
      messages: [...start],
      model,
      toolbox: toolbox([]),
      journal: journal(),
      isCancelled: async () => false,
      maxTurns: 3,
      onText: (delta) => seen.push(delta),
    });
    expect(outcome.kind).toBe('final');
    expect(seen).toEqual(['델타 ', '조각']);
  });

  it('a non-streaming model keeps working — onText is optional', async () => {
    const outcome = await driveRun({
      messages: [...start],
      model: scriptedModel([{ text: '{"action":"final","draft":{}}' }]),
      toolbox: toolbox([]),
      journal: journal(),
      isCancelled: async () => false,
      maxTurns: 3,
      onText: () => {
        throw new Error('must not be called');
      },
    });
    expect(outcome.kind).toBe('final');
  });
});

describe('run driver — parallel tool_calls with ask_human (W3 Minor-2)', () => {
  /**
   * A provider (anthropic above all) rejects the follow-up turn when an
   * assistant message's tool_use blocks have no tool_result. When ask_human
   * parks the run mid-turn, every remaining tool_call of that same turn must
   * still be answered — blocked, journaled, never executed — so run.answer
   * can resume without a provider 400.
   */
  function toolAnswersFor(messages: AgentMessage[], assistantToolCalls: AgentToolCall[]): AgentToolCall[] {
    const answered = messages.filter((m) => m.role === 'tool').map((m) => (m as { toolCallId: string }).toolCallId);
    return assistantToolCalls.filter((call) => !answered.includes(call.id));
  }

  it('ask_human first parks the run and answers the trailing calls — none executed', async () => {
    const calls: AgentToolCall[] = [
      { id: 'a1', name: 'ask_human', input: { question: '예산이 어느 정도인가요?' } },
      { id: 't1', name: 'echo', input: { text: '뒤에 남은 호출' } },
      { id: 't2', name: 'echo', input: { text: '더 뒤' } },
    ];
    const model = scriptedModel([{ toolCalls: calls }]);
    const executed: string[] = [];
    const j = journal();
    const outcome = await driveRun({
      messages: [...start],
      model,
      toolbox: toolbox([ASK_HUMAN_TOOL, echoTool], executed),
      journal: j,
      isCancelled: async () => false,
      maxTurns: 4,
    });
    expect(outcome.kind).toBe('needs_input');
    if (outcome.kind !== 'needs_input') return;
    expect(outcome.question).toBe('예산이 어느 정도인가요?');
    expect(executed).toEqual(['ask_human']);
    expect(toolAnswersFor(outcome.messages, calls)).toEqual([]);
    expect(j.lines.some((line) => line.line.includes('parked_by_ask'))).toBe(true);
  });

  it('a tool before ask_human is executed and answered; nothing trails unanswered', async () => {
    const calls: AgentToolCall[] = [
      { id: 't0', name: 'echo', input: { text: '앞' } },
      { id: 'a1', name: 'ask_human', input: { question: '범위 확인' } },
    ];
    const model = scriptedModel([{ toolCalls: calls }]);
    const executed: string[] = [];
    const outcome = await driveRun({
      messages: [...start],
      model,
      toolbox: toolbox([ASK_HUMAN_TOOL, echoTool], executed),
      journal: journal(),
      isCancelled: async () => false,
      maxTurns: 4,
    });
    expect(outcome.kind).toBe('needs_input');
    if (outcome.kind !== 'needs_input') return;
    expect(executed).toEqual(['echo', 'ask_human']);
    expect(toolAnswersFor(outcome.messages, calls)).toEqual([]);
  });

  it('an undeclared call after ask_human is answered too — not silently stranded', async () => {
    const calls: AgentToolCall[] = [
      { id: 'a1', name: 'ask_human', input: { question: 'q' } },
      { id: 'x1', name: 'not_declared', input: {} },
    ];
    const model = scriptedModel([{ toolCalls: calls }]);
    const executed: string[] = [];
    const outcome = await driveRun({
      messages: [...start],
      model,
      toolbox: toolbox([ASK_HUMAN_TOOL, echoTool], executed),
      journal: journal(),
      isCancelled: async () => false,
      maxTurns: 4,
    });
    expect(outcome.kind).toBe('needs_input');
    if (outcome.kind !== 'needs_input') return;
    expect(toolAnswersFor(outcome.messages, calls)).toEqual([]);
  });
});
