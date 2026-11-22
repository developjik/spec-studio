import { describe, expect, it } from 'vitest';
import {
  canAnswer,
  canCancel,
  canResume,
  eventSummary,
  isLive,
  questionOf,
  upsertRun,
  RUN_STATE_LABEL,
  RUN_TERMINAL,
} from '../src/model/runview';
import type { RunRecord, RunState } from '@spec-studio/protocol';
import type { RunLogLineView } from '../src/model/daemon';

/**
 * The run panel's pure gates (E3 W2). A1 is the load-bearing one: the answer
 * field renders only while the run is needs_input — before that, and after
 * every terminal state, it is simply not there.
 */

function run(state: RunState, interrupted = false): RunRecord {
  return {
    id: 'R_test0001',
    projectId: 'P_1',
    taskId: 'I_00000001',
    agent: 'researcher',
    mode: 'research',
    state,
    interrupted,
    outwardAt: null,
    startedAt: '2026-11-22T00:00:00.000Z',
    endedAt: null,
  };
}

describe('A1 — the answer field lives only under needs_input', () => {
  it('every live non-asking state hides it; every terminal state hides it', () => {
    for (const state of ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled'] as const) {
      expect(canAnswer(run(state))).toBe(false);
    }
    expect(canAnswer(null)).toBe(false);
    expect(canAnswer(run('needs_input'))).toBe(true);
  });
});

describe('command gating matches the state machine', () => {
  it('cancel is offered only while the run lives', () => {
    for (const state of ['queued', 'running', 'waiting', 'needs_input', 'review'] as const) {
      expect(canCancel(run(state))).toBe(true);
    }
    for (const state of ['done', 'failed', 'cancelled'] as const) {
      expect(canCancel(run(state))).toBe(false);
    }
    expect(canCancel(null)).toBe(false);
  });

  it('resume needs the restart flag and a living run', () => {
    expect(canResume(run('running', true))).toBe(true);
    expect(canResume(run('running', false))).toBe(false);
    expect(canResume(run('done', true))).toBe(false);
    expect(canResume(null)).toBe(false);
  });

  it('isLive/RUN_TERMINAL name the same fixed points the machine knows', () => {
    for (const state of ['done', 'failed', 'cancelled'] as const) {
      expect(RUN_TERMINAL.has(state)).toBe(true);
      expect(isLive(run(state))).toBe(false);
    }
    expect(isLive(run('queued'))).toBe(true);
  });
});

describe('the journal answers the question and summarizes events', () => {
  const log: RunLogLineView[] = [
    { stream: 'stdout', line: '조사를 시작합니다' },
    { stream: 'event', line: JSON.stringify({ tool: 'ask_human', blocked: false }) },
    { stream: 'event', line: JSON.stringify({ needs_input: true, question: '예산 한도는?' }) },
  ];

  it('questionOf reads the last needs_input event', () => {
    expect(questionOf(log)).toBe('예산 한도는?');
    expect(questionOf([...log, { stream: 'event', line: JSON.stringify({ needs_input: true, question: '기한은?' }) }])).toBe('기한은?');
    expect(questionOf([{ stream: 'stdout', line: 'x' }])).toBeNull();
  });

  it('eventSummary renders one honest line per structured event', () => {
    expect(eventSummary(JSON.stringify({ needs_input: true, question: 'q?' }))).toBe('질문: q?');
    expect(eventSummary(JSON.stringify({ tool: 'x', blocked: true }))).toContain('차단');
    expect(eventSummary(JSON.stringify({ card: true }))).toContain('결정카드');
    expect(eventSummary('not json')).toBeNull();
  });
});

describe('upsertRun — a stream update lands in place', () => {
  it('replaces by id and appends the unknown', () => {
    const list = [run('queued'), run('running')];
    const next = { ...list[0]!, state: 'running' as const };
    const merged = upsertRun(list, next);
    expect(merged[0]!.state).toBe('running');
    expect(merged).toHaveLength(2);
    expect(upsertRun(merged, { ...run('done'), id: 'R_new00000' })).toHaveLength(3);
  });
});

describe('labels', () => {
  it('every state the machine knows has a Korean label', () => {
    for (const state of ['queued', 'running', 'waiting', 'needs_input', 'review', 'done', 'failed', 'cancelled'] as const) {
      expect(RUN_STATE_LABEL[state].length).toBeGreaterThan(0);
    }
  });
});
