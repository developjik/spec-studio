import { describe, expect, it } from 'vitest';
import {
  isTerminalRunState,
  machineTransition,
  personTransition,
  RUN_STATES,
  type RunRecord,
  type RunSeed,
} from '../src/runtime';

const T0 = '2026-11-22T03:00:00Z';
const T1 = '2026-11-22T03:01:00Z';
const T2 = '2026-11-22T03:05:00Z';

const seed: RunSeed = {
  id: 'R_abcdefgh1234',
  projectId: 'PRJ_test',
  taskId: 'I_abcdefgh1234',
  agent: 'researcher',
  mode: 'research',
  state: null,
};

function run(state: RunRecord['state'], interrupted = false): RunRecord {
  return { ...seed, state, interrupted, outwardAt: null, startedAt: null, endedAt: null };
}

describe('run state machine (F1 · AC-2)', () => {
  it('spells the eight states of the v17 CHECK constraint', () => {
    expect([...RUN_STATES]).toEqual([
      'queued',
      'running',
      'waiting',
      'needs_input',
      'review',
      'done',
      'failed',
      'cancelled',
    ]);
  });

  it('marks exactly done · failed · cancelled terminal', () => {
    expect(isTerminalRunState('done')).toBe(true);
    expect(isTerminalRunState('failed')).toBe(true);
    expect(isTerminalRunState('cancelled')).toBe(true);
    for (const state of ['queued', 'running', 'waiting', 'needs_input', 'review'] as const) {
      expect(isTerminalRunState(state)).toBe(false);
    }
  });

  // ── person commands (run.*) ─────────────────────────────────────────
  it('run.start creates a queued record', () => {
    const next = personTransition(
      seed,
      { type: 'run.start', taskId: seed.taskId, agent: 'researcher', mode: 'research' },
      T0,
    );
    expect(next.state).toBe('queued');
    expect(next.interrupted).toBe(false);
  });

  it('run.cancel is legal from every live state and stamps ended_at', () => {
    for (const state of ['queued', 'running', 'waiting', 'needs_input', 'review'] as const) {
      const next = personTransition(run(state), { type: 'run.cancel', runId: seed.id, reason: '그만' }, T1);
      expect(next.state).toBe('cancelled');
      expect(next.endedAt).toBe(T1);
    }
  });

  it('run.cancel on a terminal run is refused — cancellation is not repetition', () => {
    for (const state of ['done', 'failed', 'cancelled'] as const) {
      expect(() => personTransition(run(state), { type: 'run.cancel', runId: seed.id }, T1)).toThrowError(
        /이미 끝난/,
      );
    }
  });

  it('run.answer is legal only from needs_input and hands the run back to the queue', () => {
    const asked = machineTransition(run('running'), 'needs_input', T0);
    const next = personTransition(asked, { type: 'run.answer', runId: seed.id, text: '예산 3만원까지' }, T1);
    expect(next.state).toBe('queued');
    expect(next.outwardAt).toBeNull();
    expect(() =>
      personTransition(run('running'), { type: 'run.answer', runId: seed.id, text: 'x' }, T1),
    ).toThrowError(/needs_input/);
  });

  it('run.resume clears interrupted: live work requeues, a question stays a question', () => {
    expect(personTransition(run('running', true), { type: 'run.resume', runId: seed.id }, T1)).toMatchObject({
      state: 'queued',
      interrupted: false,
    });
    expect(personTransition(run('needs_input', true), { type: 'run.resume', runId: seed.id }, T1)).toMatchObject({
      state: 'needs_input',
      interrupted: false,
    });
    expect(personTransition(run('review', true), { type: 'run.resume', runId: seed.id }, T1)).toMatchObject({
      state: 'review',
      interrupted: false,
    });
  });

  it('run.resume on a run that was never interrupted is refused', () => {
    expect(() =>
      personTransition(run('running', false), { type: 'run.resume', runId: seed.id }, T1),
    ).toThrowError(/interrupted/);
  });

  // ── machine transitions (the daemon's half) ─────────────────────────
  it('walks the happy path queued → running → waiting → running → review → done', () => {
    let record = personTransition(
      seed,
      { type: 'run.start', taskId: seed.taskId, agent: 'researcher', mode: 'research' },
      T0,
    );
    record = machineTransition(record, 'running', T0);
    expect(record.startedAt).toBe(T0);
    record = machineTransition(record, 'waiting', T0);
    record = machineTransition(record, 'running', T0);
    record = machineTransition(record, 'review', T1);
    expect(record.outwardAt).toBe(T1);
    record = machineTransition(record, 'done', T2);
    expect(record.state).toBe('done');
    expect(record.endedAt).toBe(T2);
  });

  it('needs_input is outward — the person door stamps outward_at, coming back clears it', () => {
    const asked = machineTransition(run('running'), 'needs_input', T0);
    expect(asked.outwardAt).toBe(T0);
    expect(machineTransition(asked, 'running', T1).outwardAt).toBeNull();
  });

  it('refuses machine jumps the spec does not allow', () => {
    expect(() => machineTransition(run('queued'), 'done', T0)).toThrowError(/허용되지/);
    expect(() => machineTransition(run('review'), 'running', T0)).toThrowError(/허용되지/);
    expect(() => machineTransition(run('done'), 'running', T0)).toThrowError(/허용되지/);
  });

  it('failed and cancelled are reachable machine exits', () => {
    expect(machineTransition(run('running'), 'failed', T0).state).toBe('failed');
    expect(machineTransition(run('running'), 'cancelled', T0).state).toBe('cancelled');
  });
});
