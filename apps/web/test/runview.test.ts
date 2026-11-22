import { describe, expect, it } from 'vitest';
import {
  canAnswer,
  canCancel,
  canResume,
  eventSummary,
  questionOf,
  runLabel,
  runLogItems,
  summarizeStdout,
  isLive,
  upsertRun,
  webSearchNotice,
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

describe('웹 검색 배지 (E3 F2 · QA 재검증 R1) — 강등이 화면에 도달한다', () => {
  it('eventSummary renders the availability events instead of hiding them', () => {
    expect(eventSummary(JSON.stringify({ web_search: 'available' }))).toBe('웹 검색 사용 가능');
    expect(eventSummary(JSON.stringify({ web_search: 'unavailable', reason: 'no_api_key' }))).toBe(
      '웹 검색 불가: TAVILY_API_KEY 키가 없습니다. 키를 설정한 뒤 이 런을 재개하세요.',
    );
  });

  it('webSearchNotice flags the degraded run — and clears when a later pickup had the key', () => {
    const degraded: RunLogLineView[] = [
      { stream: 'event', line: JSON.stringify({ web_search: 'unavailable', reason: 'no_api_key' }) },
    ];
    expect(webSearchNotice(degraded)).toBe(
      '웹 검색 불가: TAVILY_API_KEY 키가 없습니다. 키를 설정한 뒤 이 런을 재개하세요.',
    );
    expect(webSearchNotice([])).toBeNull();
    expect(
      webSearchNotice([
        ...degraded,
        { stream: 'event', line: JSON.stringify({ web_search: 'available' }) },
      ]),
    ).toBeNull();
  });
});

describe('labels', () => {
  it('every state the machine knows has a Korean label', () => {
    for (const state of ['queued', 'running', 'waiting', 'needs_input', 'review', 'done', 'failed', 'cancelled'] as const) {
      expect(RUN_STATE_LABEL[state].length).toBeGreaterThan(0);
    }
  });
});

describe('runLabel — the interrupted park shows one word (W3)', () => {
  it('a parked live run reads 중단됨, whatever state it parked from', () => {
    expect(runLabel({ state: 'waiting', interrupted: true })).toBe('중단됨');
    expect(runLabel({ state: 'running', interrupted: true })).toBe('중단됨');
  });

  it('an unparked run keeps its state label, and terminal flags never say 중단됨', () => {
    expect(runLabel({ state: 'waiting', interrupted: false })).toBe('도구 대기');
    expect(runLabel({ state: 'needs_input', interrupted: true })).toBe('중단됨'); // interrupted·live 표기 우선
  });

  it('the journal spells out why it stopped', () => {
    expect(
      eventSummary(JSON.stringify({ interrupted: true, reason: 'inactivity_timeout', detail: '활동 없이 600초' })),
    ).toBe('중단됨(타임아웃) — 활동 없이 600초');
    expect(eventSummary(JSON.stringify({ interrupted: true, reason: 'provider_error' }))).toBe('중단됨(오류)');
  });
});

describe('P3-1 — the log a person reads, not the JSON the model said', () => {
  it('joins consecutive stdout rows so a streamed envelope becomes one text', () => {
    const items = runLogItems([
      { stream: 'stdout', line: '{"action":"final","draft":' },
      { stream: 'stdout', line: '{"title":"경쟁 브리프"}}' },
      { stream: 'event', line: JSON.stringify({ card: true, taskId: 'I_1' }) },
      { stream: 'stderr', line: '경고' },
    ]);
    expect(items).toEqual([
      { kind: 'stdout', text: '{"action":"final","draft":{"title":"경쟁 브리프"}}' },
      { kind: 'event', line: JSON.stringify({ card: true, taskId: 'I_1' }) },
      { kind: 'stderr', line: '경고' },
    ]);
  });

  it('collapses a complete final envelope into one human line', () => {
    const envelope =
      '{"action":"final","draft":{"title":"t","summary":"s","claims":[{"text":"주장","ungrounded":true}]}}';
    expect(summarizeStdout(envelope)).toContain('최종');
    expect(summarizeStdout('{"action":"ask","question":"예산은?"}')).toContain('질문');
    // prose the model streams mid-run stays exactly what it said
    expect(summarizeStdout('취소 정책을 조사하겠습니다.')).toBeNull();
    // a partial envelope (stream still in flight) is progress, not noise to hide
    expect(summarizeStdout('{"action":"final","draft":')).toBeNull();
  });
});
