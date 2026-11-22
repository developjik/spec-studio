import type { Command, RunId, RunMode, RunRecord, RunState } from '@spec-studio/protocol';
import { RUN_TERMINAL_STATES } from '@spec-studio/protocol';

export type { RunRecord } from '@spec-studio/protocol';

/**
 * The run state machine (E3 F1 · AC-2), pure: time arrives as an argument,
 * persistence belongs to the store, and the only thing this module knows how
 * to do is decide which move is legal and what the record looks like after.
 *
 * Two doors move a run:
 *  - the person's commands — run.start · run.cancel · run.resume · run.answer;
 *  - the machine's transitions — the daemon picking work up, waiting on a
 *    model or tool, going outward to ask, ending.
 * Everything else is refused, so the CHECK constraint in v17 and this table
 * can never tell different stories.
 */

export { RUN_STATES, RUN_TERMINAL_STATES } from '@spec-studio/protocol';

/**
 * Why a person's run command was refused. Each code has a fixed HTTP status
 * in the daemon's mapping — a client reads `code`, never parses the message.
 * `agent` cannot import core's DomainError (port-driven boundary), so the
 * machine keeps its own refusal type.
 */
export type RunRefusalCode = 'run_terminal' | 'run_not_asking' | 'run_not_interrupted';

export class RunRefusal extends Error {
  readonly code: RunRefusalCode;

  constructor(code: RunRefusalCode, message: string) {
    super(message);
    this.name = 'RunRefusal';
    this.code = code;
  }
}

/** A run that does not exist yet — what run.start is handed. */
export interface RunSeed {
  id: RunId;
  projectId: string;
  taskId: string;
  agent: string;
  mode: RunMode;
  state: null;
}

export function isTerminalRunState(state: RunState): boolean {
  return (RUN_TERMINAL_STATES as readonly string[]).includes(state);
}

/** The person-command half of the machine. Throws on an illegal move. */
export function personTransition(
  record: RunSeed | RunRecord,
  command: PersonRunCommand,
  at: string,
): RunRecord {
  if (command.type === 'run.start') {
    const seed = record as RunSeed;
    return {
      id: seed.id,
      projectId: seed.projectId,
      taskId: command.taskId,
      agent: command.agent,
      mode: command.mode,
      state: 'queued',
      interrupted: false,
      outwardAt: null,
      startedAt: null,
      endedAt: null,
    };
  }

  const current = record as RunRecord;
  // A finished run answers every command the same way: terminal first, so a
  // late answer or resume is `run_terminal`, not a state complaint (W2).
  const terminal = isTerminalRunState(current.state);
  switch (command.type) {
    case 'run.cancel': {
      if (terminal) {
        throw new RunRefusal('run_terminal', `이미 끝난 런입니다 (${current.state}) — 취소는 반복되지 않습니다`);
      }
      // Cancelling is itself an acknowledgment — no restart flag outlives
      // the run (AC-2: the flag lives only on runs that still are).
      return { ...current, state: 'cancelled', interrupted: false, endedAt: at };
    }
    case 'run.answer': {
      if (terminal) {
        throw new RunRefusal('run_terminal', `이미 끝난 런입니다 (${current.state}) — 답변할 수 없습니다`);
      }
      if (current.state !== 'needs_input') {
        throw new RunRefusal('run_not_asking', `답변은 needs_input 상태에서만 받습니다 (현재 ${current.state})`);
      }
      // The answer hands the run straight back to the queue; the runner
      // appends the message and continues from the checkpoint. Answering is
      // also the acknowledgment a restart was waiting for, so the flag goes.
      return { ...current, state: 'queued', outwardAt: null, interrupted: false };
    }
    case 'run.resume': {
      if (terminal) {
        throw new RunRefusal('run_terminal', `이미 끝난 런입니다 (${current.state}) — 재개할 수 없습니다`);
      }
      if (!current.interrupted) {
        throw new RunRefusal('run_not_interrupted', 'interrupted 표시가 없는 런은 재개할 수 없습니다');
      }
      if (current.state === 'needs_input' || current.state === 'review') {
        // A question is still a question; a card still waits. Only the
        // interruption flag was the restart's business.
        return { ...current, interrupted: false };
      }
      return { ...current, state: 'queued', interrupted: false };
    }
  }
}

export type PersonRunCommand = Extract<
  Command,
  { type: 'run.start' | 'run.cancel' | 'run.resume' | 'run.answer' }
>;

/** Moves the machine half allows, keyed from the current state. */
const MACHINE_MOVES: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['waiting', 'needs_input', 'review', 'done', 'failed', 'cancelled'],
  waiting: ['running', 'cancelled', 'failed'],
  needs_input: ['running', 'cancelled', 'failed'],
  review: ['done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

/**
 * The daemon's half. `to` must be a move MACHINE_MOVES allows; the stamps the
 * spec cares about (started_at · ended_at · outward_at) are derived here so
 * no caller can forget one.
 */
export function machineTransition(record: RunRecord, to: RunState, at: string): RunRecord {
  if (!MACHINE_MOVES[record.state].includes(to)) {
    throw new Error(`${record.state} → ${to} 는 허용되지 않는 전이입니다`);
  }
  return {
    ...record,
    state: to,
    startedAt: record.startedAt ?? (to === 'running' ? at : null),
    outwardAt: to === 'needs_input' || to === 'review' ? at : to === 'running' ? null : record.outwardAt,
    endedAt: isTerminalRunState(to) ? at : null,
    // The restart flag is a question about a live run; a finished run has
    // nothing left to ask (AC-2 종소점), so the flag never outlives it.
    interrupted: isTerminalRunState(to) ? false : record.interrupted,
  };
}
