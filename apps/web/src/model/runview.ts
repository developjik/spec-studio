import type { RunRecord, RunState } from '@spec-studio/protocol';
import type { RunLogLineView } from './daemon';

/**
 * The run panel's pure decisions (E3 W2 · AC-9/A1). Every gate the UI renders
 * answers here first — the state machine behind them already refuses wrong
 * commands, so a hidden button is honesty about the surface, not the guard.
 */

export const RUN_TERMINAL: ReadonlySet<RunState> = new Set(['done', 'failed', 'cancelled']);

export const RUN_STATE_LABEL: Record<RunState, string> = {
  queued: '대기',
  running: '실행 중',
  waiting: '도구 대기',
  needs_input: '답변 대기',
  review: '카드 검토',
  done: '완료',
  failed: '실패',
  cancelled: '취소됨',
};

/**
 * W3 waiting 데드 상태: a parked run shows one word — 중단됨 — not the
 * machine's `waiting`. The reason rides the journal's `interrupted` event
 * (eventSummary spells it out); resume·cancel are the same AC-2 buttons.
 */
export function runLabel(run: Pick<RunRecord, 'state' | 'interrupted'> | null): string {
  if (run !== null && run.interrupted && !RUN_TERMINAL.has(run.state)) return '중단됨';
  return run === null ? '' : RUN_STATE_LABEL[run.state];
}

/** A1: the answer field exists only while the run waits on the person. */
export function canAnswer(run: Pick<RunRecord, 'state'> | null): boolean {
  return run?.state === 'needs_input';
}

export function canCancel(run: Pick<RunRecord, 'state'> | null): boolean {
  return run !== null && !RUN_TERMINAL.has(run.state);
}

/** run.resume is honest only when a restart actually flagged the run. */
export function canResume(run: Pick<RunRecord, 'state' | 'interrupted'> | null): boolean {
  return run !== null && run.interrupted && !RUN_TERMINAL.has(run.state);
}

export function isLive(run: Pick<RunRecord, 'state'> | null): boolean {
  return run !== null && !RUN_TERMINAL.has(run.state);
}

/** Inserts or replaces a run in the list — how a stream update lands. */
export function upsertRun(list: readonly RunRecord[], next: RunRecord): RunRecord[] {
  const index = list.findIndex((run) => run.id === next.id);
  if (index === -1) return [...list, next];
  return [...list.slice(0, index), next, ...list.slice(index + 1)];
}

/**
 * The question a needs_input run is waiting on. The journal carries it as a
 * structured `event` line; the last one wins, so a re-asked question is the
 * question on screen.
 */
export function questionOf(log: readonly RunLogLineView[]): string | null {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const entry = log[index];
    if (entry === undefined || entry.stream !== 'event') continue;
    try {
      const parsed = JSON.parse(entry.line) as { needs_input?: boolean; question?: string };
      if (
        parsed.needs_input === true &&
        typeof parsed.question === 'string' &&
        parsed.question.trim() !== ''
      ) {
        return parsed.question.trim();
      }
    } catch {
      // not a structured journal line — keep looking
    }
  }
  return null;
}

/** An event line's one-line summary for the log area; null hides noise. */
export function eventSummary(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as {
      needs_input?: boolean;
      question?: string;
      tool?: string;
      blocked?: boolean;
      final?: boolean;
      card?: boolean;
      interrupted?: boolean;
      reason?: string;
      detail?: string;
    };
    if (parsed.interrupted === true) {
      const why = parsed.reason === 'inactivity_timeout' ? '타임아웃' : '오류';
      return `중단됨(${why})${parsed.detail === undefined ? '' : ` — ${parsed.detail}`}`;
    }
    if (parsed.needs_input === true) return `질문: ${parsed.question ?? ''}`;
    if (parsed.final === true) return '최종 초안 작성 완료';
    if (parsed.card === true) return '리서치 문서에 결정카드 등록';
    if (typeof parsed.tool === 'string') {
      return `도구 ${parsed.tool}${parsed.blocked === true ? ' — 차단됨(미선언)' : ' 실행'}`;
    }
    return null;
  } catch {
    return null;
  }
}
