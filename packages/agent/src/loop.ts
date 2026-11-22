import {
  AgentMessageSchema,
  type AgentMessage,
  type AgentToolCall,
  type AgentToolSpec,
} from '@spec-studio/protocol';

/**
 * The run driver (E3 F1): multi-turn, tool-whitelisted, cancellable. Pure in
 * the same sense core is — every effect arrives as a port, so tests script a
 * model and a toolbox and nothing here touches disk, network or clock.
 *
 * Three rules the driver is the last line of:
 *  - AC-4: a tool the whitelist does not declare never executes. The call is
 *    journaled and answered to the model as blocked, so the loop can recover.
 *  - AC-2 ask: `ask_human` is the only way outward; it parks the run.
 *  - AC-2 cancel: between every model call and every tool execution the
 *    cancellation is checked; after it, zero further calls happen.
 */

/** What the model layer must answer one turn with. */
export interface ModelPort {
  turn(request: {
    messages: AgentMessage[];
    tools: AgentToolSpec[];
    signal?: AbortSignal;
  }): Promise<{ text: string; toolCalls: AgentToolCall[] }>;
}

/** The daemon's toolbox: the whitelist, and the only executor there is. */
export interface ToolBox {
  /** The declared whitelist for this run — AC-4's list. */
  specs(): AgentToolSpec[];
  /** Executes one whitelisted call. `ask_human` resolves here too. */
  execute(call: AgentToolCall, signal?: AbortSignal): Promise<{ ok: boolean; output: string }>;
}

/** The journal the driver leaves in `run_log` (stream · line). */
export interface Journal {
  log(stream: 'stdout' | 'stderr' | 'event', line: string): void;
}

/** One line the journal wrote — the store's run_log row. */
export interface JournalLine {
  stream: 'stdout' | 'stderr' | 'event';
  line: string;
}

export type RunOutcome =
  | { kind: 'final'; draft: unknown; messages: AgentMessage[] }
  | { kind: 'needs_input'; question: string; messages: AgentMessage[] }
  | { kind: 'cancelled'; messages: AgentMessage[] }
  | { kind: 'failed'; reason: string; messages: AgentMessage[] };

export interface DriveOptions {
  messages: AgentMessage[];
  model: ModelPort;
  toolbox: ToolBox;
  journal: Journal;
  isCancelled(): boolean | Promise<boolean>;
  /** Hard ceiling on model turns; the honest failure beyond it. */
  maxTurns: number;
}

const FINAL_MAX_RETRY = 2;

/** Parses the model's final answer, tolerating a ```json fence. */
function parseEnvelope(text: string): { action: 'ask'; question: string } | { action: 'final'; draft: unknown } | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
    if (parsed.action === 'ask' && typeof parsed.question === 'string' && parsed.question.trim() !== '') {
      return { action: 'ask', question: parsed.question.trim() };
    }
    if (parsed.action === 'final' && 'draft' in parsed) {
      return { action: 'final', draft: parsed.draft };
    }
  } catch {
    return null;
  }
  return null;
}

async function cancelledNow(options: DriveOptions): Promise<boolean> {
  return await options.isCancelled();
}

/**
 * Drives the run to its next stopping point: a final draft, a question for
 * the person, a cancellation, or an honest failure. The caller owns what a
 * stopping point means in the store — this function only runs the loop.
 */
export async function driveRun(options: DriveOptions): Promise<RunOutcome> {
  const messages: AgentMessage[] = [...options.messages];
  let finalRetries = 0;

  for (let turn = 0; turn < options.maxTurns; turn += 1) {
    if (await cancelledNow(options)) return { kind: 'cancelled', messages };

    const controller = new AbortController();
    const onExternalCancel = () => controller.abort();
    // The isCancelled port is the store's word; wire it into the signal so
    // in-flight model calls and tools see the abort too.
    const checkTimer = setInterval(() => {
      void cancelledNow(options).then((down) => {
        if (down) onExternalCancel();
      });
    }, 25);
    let answer: Awaited<ReturnType<ModelPort['turn']>>;
    try {
      answer = await options.model.turn({
        messages,
        tools: options.toolbox.specs(),
        signal: controller.signal,
      });
    } catch (error) {
      clearInterval(checkTimer);
      if (await cancelledNow(options)) return { kind: 'cancelled', messages };
      return {
        kind: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        messages,
      };
    }
    clearInterval(checkTimer);
    if (await cancelledNow(options)) return { kind: 'cancelled', messages };

    messages.push(AgentMessageSchema.parse({ role: 'assistant', text: answer.text, toolCalls: answer.toolCalls }));

    // Tool calls first: a turn that asks for tools is not final.
    if (answer.toolCalls.length > 0) {
      const declared = new Set(options.toolbox.specs().map((spec) => spec.name));
      for (const call of answer.toolCalls) {
        if (await cancelledNow(options)) return { kind: 'cancelled', messages };
        if (!declared.has(call.name)) {
          // AC-4: the wall. Blocked and journaled — never executed, never
          // silently dropped; the model is told so it can choose again.
          options.journal.log(
            'event',
            JSON.stringify({ tool: call.name, blocked: true, reason: 'not_declared' }),
          );
          messages.push(
            AgentMessageSchema.parse({
              role: 'tool',
              toolCallId: call.id,
              name: call.name,
              ok: false,
              output: '차단되었습니다: 선언되지 않은 도구입니다.',
            }),
          );
          continue;
        }
        options.journal.log('event', JSON.stringify({ tool: call.name, blocked: false }));
        let outcome: { ok: boolean; output: string };
        try {
          outcome = await options.toolbox.execute(call, controller.signal);
        } catch (error) {
          if (await cancelledNow(options)) return { kind: 'cancelled', messages };
          outcome = {
            ok: false,
            output: error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400),
          };
        }
        if (await cancelledNow(options)) {
          // The tool answered, but the run is down: its result is not used.
          return { kind: 'cancelled', messages };
        }
        messages.push(
          AgentMessageSchema.parse({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            ok: outcome.ok,
            output: outcome.output.slice(0, 16_000),
          }),
        );
        if (call.name === 'ask_human' && outcome.ok) {
          const asked = parseAskOutput(outcome.output);
          if (asked !== null) {
            options.journal.log('event', JSON.stringify({ needs_input: true, question: asked }));
            return { kind: 'needs_input', question: asked, messages };
          }
        }
      }
      continue;
    }

    // A text-only turn is the model's verdict: ask, or the final draft.
    const envelope = parseEnvelope(answer.text);
    if (envelope === null) {
      finalRetries += 1;
      if (finalRetries >= FINAL_MAX_RETRY) {
        return { kind: 'failed', reason: '모델이 응답 형식을 지키지 않았습니다', messages };
      }
      messages.push(
        AgentMessageSchema.parse({
          role: 'user',
          text: '응답은 다음 JSON 중 하나여야 합니다: {"action":"ask","question":"…"} 또는 {"action":"final","draft":{…브리프 초안}}. 다시 답해 주세요.',
        }),
      );
      continue;
    }
    if (envelope.action === 'ask') {
      options.journal.log('event', JSON.stringify({ needs_input: true, question: envelope.question }));
      return { kind: 'needs_input', question: envelope.question, messages };
    }
    options.journal.log('event', JSON.stringify({ final: true }));
    return { kind: 'final', draft: envelope.draft, messages };
  }

  return { kind: 'failed', reason: `최대 턴(${options.maxTurns})을 넘겼습니다`, messages };
}

function parseAskOutput(output: string): string | null {
  try {
    const parsed = JSON.parse(output) as { asked?: boolean; question?: string };
    if (parsed.asked === true && typeof parsed.question === 'string' && parsed.question.trim() !== '') {
      return parsed.question.trim();
    }
  } catch {
    return null;
  }
  return null;
}
