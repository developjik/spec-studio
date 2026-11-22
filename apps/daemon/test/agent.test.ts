import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentToolCall, Project, RunRecord } from '@spec-studio/protocol';
import type { ModelPort } from '@spec-studio/agent';
import { startDaemon, type Daemon } from '../src/server';

/**
 * E3 W1's gate, end to end through the daemon's own HTTP API against a real
 * SQLite file — the same road the app would take:
 *
 *  AC-1  the run produces one decision card; the person adopts it; the
 *        ledger says `ai:<runId>` — and nothing else was written by the run.
 *  AC-2  the run asks (needs_input), the person answers, it continues;
 *        a daemon restart marks the live run interrupted and it resumes.
 *  AC-4  a tool the whitelist never declared is blocked and journaled.
 */

let dir = '';
let dbPath = '';
const daemons: Daemon[] = [];

interface TurnScript {
  /** Text deltas the turn emits through onText — AC-9's progress. */
  stream?: string[];
  /** How long the turn lingers after streaming — lets a watcher catch it. */
  delayMs?: number;
  text?: string;
  toolCalls?: AgentToolCall[];
}

/** A model whose answers are a queue a test controls. */
function scriptedModel(scripts: TurnScript[], onTurn?: (index: number) => void): ModelPort & { calls: number } {
  let index = 0;
  const port: ModelPort & { calls: number } = {
    calls: 0,
    async turn(request) {
      if (request.signal?.aborted) throw new Error('aborted');
      port.calls += 1;
      onTurn?.(port.calls);
      const script = scripts[Math.min(index, scripts.length - 1)] ?? {};
      index += 1;
      for (const delta of script.stream ?? []) request.onText?.(delta);
      if (script.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, script.delayMs));
      }
      return { text: script.text ?? '', toolCalls: script.toolCalls ?? [] };
    },
  };
  return port;
}

function boot(model: ModelPort): Promise<Daemon> {
  return startDaemon({
    dbPath,
    port: 0,
    now: () => '2026-11-22T07:00:00.000Z',
    agent: { modelPort: model },
  }).then((started) => {
    daemons.push(started);
    return started;
  });
}

async function api<T>(
  target: Daemon,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${target.url}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

type CommandBody = {
  project: Project;
  opSeq?: number;
  events?: Array<{ type: string; run?: { id: string } }>;
  error?: { code?: string; message?: string };
};

async function command(target: Daemon, projectId: string, body: unknown) {
  return api<CommandBody>(target, `/api/projects/${projectId}/commands`, {
    method: 'POST',
    body: { command: body },
  });
}

function runIdOf(started: { body: CommandBody }): string {
  const run = started.body.events?.find((event) => event.type === 'run.started')?.run;
  if (run === undefined) throw new Error('run.start did not return its run event');
  return run.id;
}

async function seed(target: Daemon): Promise<{ projectId: string; ideaId: string }> {
  const created = await api<{ project: Project }>(target, '/api/projects', {
    method: 'POST',
    body: { name: '에이전트 런 e2e' },
  });
  const projectId = created.body.project.id;
  const captured = await command(target, projectId, { type: 'idea.capture', text: '경쟁 브리프 자동 조사' });
  const ideaId = (captured.body.project.ideas[0] ?? null)?.id as string;
  await command(target, projectId, { type: 'doc.create', title: '리서치', kind: 'research' });
  return { projectId, ideaId };
}

async function waitRun(
  target: Daemon,
  projectId: string,
  runId: string,
  where: (run: RunRecord) => boolean,
  timeoutMs = 5000,
): Promise<RunRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await api<{ run: RunRecord }>(target, `/api/projects/${projectId}/runs/${runId}`);
    if (detail.status === 200 && where(detail.body.run)) return detail.body.run;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not reach the expected state in time`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const FINAL = {
  text: '{"action":"final","draft":{"title":"경쟁 브리프","summary":"요약","claims":[{"text":"주장","ungrounded":true}]}}',
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spec-studio-agent-'));
  dbPath = join(dir, 'graph.db');
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a run, end to end (AC-1 · AC-2 · AC-4)', () => {
  it('asks, is answered, blocks an undeclared tool, cards, and stamps its adoption', async () => {
    const model = scriptedModel([
      { toolCalls: [{ id: 't1', name: 'ask_human', input: { question: '예산은 얼마까지?' } }] },
      { toolCalls: [{ id: 't2', name: 'web_search', input: { q: '경쟁사' } }] },
      FINAL,
    ]);
    const daemon = await boot(model);
    const { projectId, ideaId } = await seed(daemon);

    // 1. the person starts a research run on the idea
    const started = await command(daemon, projectId, {
      type: 'run.start',
      taskId: ideaId,
      agent: 'researcher',
      mode: 'research',
    });
    const runId = runIdOf(started);

    // 2. it parks on the person's question (AC-2)
    const asked = await waitRun(daemon, projectId, runId, (run) => run.state === 'needs_input');
    expect(asked.outwardAt).not.toBeNull();

    // 3. the person answers; the run continues (AC-2)
    await command(daemon, projectId, { type: 'run.answer', runId, text: '예산 3만원까지' });

    // 4. the undeclared web_search is blocked, not executed (AC-4) — then final
    const reviewing = await waitRun(daemon, projectId, runId, (run) => run.state === 'review');
    expect(reviewing.outwardAt).not.toBeNull();

    const detail = await api<{ run: RunRecord; log: Array<{ stream: string; line: string }> }>(
      daemon,
      `/api/projects/${projectId}/runs/${runId}`,
    );
    const blocked = detail.body.log.find((line) => line.line.includes('web_search') && line.line.includes('blocked'));
    expect(blocked).toBeDefined(); // the wall is in the journal
    expect(detail.body.log.some((line) => line.line.includes('예산 3만원까지'))).toBe(true);

    // 5. the card exists, linked to its run; the person adopts; done (AC-1)
    const withCard = await api<{ project: Project }>(daemon, `/api/projects/${projectId}`);
    const card = withCard.body.project.proposals.find((proposal) => proposal.authorId === runId);
    expect(card).toBeDefined();
    expect(card?.ideaId).toBe(ideaId);

    await command(daemon, projectId, { type: 'proposal.adopt', docId: card!.docId, proposalId: card!.id });
    const done = await waitRun(daemon, projectId, runId, (run) => run.state === 'done');
    expect(done.endedAt).not.toBeNull();

    // 6. the ledger: the adoption is the run's, by name
    const raw = new DatabaseSync(dbPath);
    try {
      const op = raw
        .prepare("SELECT actor FROM op_log WHERE kind = 'proposal.adopt' ORDER BY seq DESC LIMIT 1")
        .get() as { actor: string };
      expect(op.actor).toBe(`ai:${runId}`);
      // AC-1, 채택 전 쓰기 0건: from the run's first ledger row on, the only
      // project-content op is the card's own creation — no block/doc/pin/
      // node/link row ever carries the run's fingerprints.
      const runOps = raw
        .prepare('SELECT kind FROM op_log WHERE seq > ? ORDER BY seq')
        .all(started.body.opSeq ?? 0) as Array<{ kind: string }>;
      const projectWrites = runOps
        .map((row) => row.kind)
        .filter(
          (kind) =>
            kind.startsWith('block.') ||
            kind.startsWith('doc.') ||
            kind.startsWith('pin.') ||
            kind.startsWith('node.') ||
            kind.startsWith('link.'),
        );
      expect(projectWrites).toEqual([]);
      expect(runOps.map((row) => row.kind)).toContain('proposal.create'); // the card was the run's one write
    } finally {
      raw.close();
    }
  });

  it('cancel stops the run at once and it stays cancelled (AC-2)', async () => {
    let release: (() => void) | null = null;
    const model = scriptedModel(
      [{ toolCalls: [{ id: 't1', name: 'ask_human', input: { question: '계속할까요?' } }] }],
      () => {
        release?.();
      },
    );
    const daemon = await boot(model);
    const { projectId, ideaId } = await seed(daemon);

    const started = await command(daemon, projectId, {
      type: 'run.start',
      taskId: ideaId,
      agent: 'researcher',
    });
    const runId = runIdOf(started);
    const asked = await waitRun(daemon, projectId, runId, (run) => run.state === 'needs_input');

    // the question is outward; cancelling here is the person's right
    const cancelled = await command(daemon, projectId, { type: 'run.cancel', runId, reason: '그만' });
    expect(cancelled.status).toBe(200);
    void asked;
    const after = await api<{ run: RunRecord }>(daemon, `/api/projects/${projectId}/runs/${runId}`);
    expect(after.body.run.state).toBe('cancelled');
    expect(after.body.run.endedAt).not.toBeNull();

    // a cancelled run cannot be resurrected by answering it
    const answer = await command(daemon, projectId, { type: 'run.answer', runId, text: '늦은 답' });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    release = null;
  });
});

describe('cross-project scope (QA A4/A5 — a run answers its own project only)', () => {
  it('a run.* command through another project\'s channel is refused and the run keeps running', async () => {
    const model = scriptedModel([
      { toolCalls: [{ id: 't1', name: 'ask_human', input: { question: '계속할까요?' } }] },
    ]);
    const daemon = await boot(model);
    const { projectId, ideaId } = await seed(daemon);

    const started = await command(daemon, projectId, {
      type: 'run.start',
      taskId: ideaId,
      agent: 'researcher',
    });
    const runId = runIdOf(started);
    await waitRun(daemon, projectId, runId, (run) => run.state === 'needs_input');

    // the second channel: another project on the same daemon
    const other = await api<{ project: Project }>(daemon, '/api/projects', {
      method: 'POST',
      body: { name: '다른 프로젝트' },
    });
    const otherId = other.body.project.id;

    for (const body of [
      { type: 'run.cancel', runId, reason: '타 프로젝트' },
      { type: 'run.resume', runId },
      { type: 'run.answer', runId, text: '타 프로젝트 답' },
    ]) {
      const refused = await command(daemon, otherId, body);
      expect(refused.status).toBe(403);
      expect(refused.body.error?.code).toBe('run_scope');
    }

    // the run never noticed the foreign channel — still parked on its question
    const after = await api<{ run: RunRecord }>(daemon, `/api/projects/${projectId}/runs/${runId}`);
    expect(after.body.run.state).toBe('needs_input');
    expect(after.body.run.endedAt).toBeNull();
  });

  it('run.start aimed at another project\'s task is refused over HTTP too', async () => {
    const model = scriptedModel([FINAL]);
    const daemon = await boot(model);
    const { ideaId } = await seed(daemon);
    const other = await api<{ project: Project }>(daemon, '/api/projects', {
      method: 'POST',
      body: { name: '다른 프로젝트' },
    });
    const otherId = other.body.project.id;

    const refused = await command(daemon, otherId, {
      type: 'run.start',
      taskId: ideaId,
      agent: 'researcher',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error?.code).toBe('run_scope');

    const runs = await api<{ runs: RunRecord[] }>(daemon, `/api/projects/${otherId}/runs`);
    expect(runs.body.runs).toHaveLength(0);
  });
});

describe('run.* refusal mapping — a predictable rejection is never a 500 (W2)', () => {
  const RUN_COMMANDS = (runId: string) => [
    { type: 'run.cancel', runId, reason: 'x' },
    { type: 'run.resume', runId },
    { type: 'run.answer', runId, text: 'x' },
  ] as const;

  async function startRun(target: Daemon, projectId: string, taskId: string): Promise<string> {
    // Store-level start: the command surface is under test, not the runner —
    // and nothing picks the queued run up, so the state moves are exact.
    const started = await target.store.execute(projectId, {
      type: 'run.start',
      taskId,
      agent: 'researcher',
      mode: 'research',
    });
    const event = started.events[0] as { type: string; run: { id: string } };
    return event.run.id;
  }

  it('a terminal run answers every run.* command with 409 run_terminal — all nine combos', async () => {
    const daemon = await boot(scriptedModel([FINAL]));
    const { projectId, ideaId } = await seed(daemon);

    for (const terminal of ['done', 'failed', 'cancelled'] as const) {
      const runId = await startRun(daemon, projectId, ideaId);
      daemon.store.transitionRun(runId, 'running');
      daemon.store.transitionRun(runId, terminal);
      for (const body of RUN_COMMANDS(runId)) {
        const refused = await command(daemon, projectId, body);
        expect(refused.status).toBe(409);
        expect(refused.body.error?.code).toBe('run_terminal');
      }
      // and the run's state is still the terminal one it reached
      const after = await api<{ run: RunRecord }>(daemon, `/api/projects/${projectId}/runs/${runId}`);
      expect(after.body.run.state).toBe(terminal);
    }
  });

  it('a missing runId answers 404 run_missing', async () => {
    const daemon = await boot(scriptedModel([FINAL]));
    const { projectId } = await seed(daemon);
    for (const body of RUN_COMMANDS('R_nonexistent')) {
      const refused = await command(daemon, projectId, body);
      expect(refused.status).toBe(404);
      expect(refused.body.error?.code).toBe('run_missing');
    }
  });

  it('run.start on a same-project screen is 400 invalid_input, never a trigger 500 (Major-1)', async () => {
    const daemon = await boot(scriptedModel([FINAL]));
    const { projectId } = await seed(daemon);

    // a real screen object — the exact attack the verifier ran (S_ id, same project)
    await command(daemon, projectId, {
      type: 'screen.attach',
      screen: {
        id: 'S_attack000001',
        title: '공격용 화면',
        code: 'SCR-101',
        ref: { kind: 'image', value: 'data:image/png;base64,iVBORw0KGgo=' },
        viewport: { width: 100, height: 100 },
        createdAt: '2026-11-22T00:00:00.000Z',
        updatedAt: '2026-11-22T00:00:00.000Z',
      },
    });

    const refused = await command(daemon, projectId, {
      type: 'run.start',
      taskId: 'S_attack000001',
      agent: 'researcher',
      mode: 'research',
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error?.code).toBe('invalid_input');
    // the trigger's raw SQLite message never reaches the client — the
    // refusal is a domain sentence naming the allowed kinds instead.
    expect(refused.body.error?.message).not.toContain('run_task_must_be_specnode_pin_or_idea');

    const runs = await api<{ runs: RunRecord[] }>(daemon, `/api/projects/${projectId}/runs`);
    expect(runs.body.runs).toHaveLength(0); // the refused start left no run row
  });

  it('live-state refusals answer 409: answer outside needs_input · resume without the flag', async () => {
    const daemon = await boot(scriptedModel([FINAL]));
    const { projectId, ideaId } = await seed(daemon);
    const runId = await startRun(daemon, projectId, ideaId);
    daemon.store.transitionRun(runId, 'running');

    const early = await command(daemon, projectId, { type: 'run.answer', runId, text: '너무 이른 답' });
    expect(early.status).toBe(409);
    expect(early.body.error?.code).toBe('run_not_asking');

    const plain = await command(daemon, projectId, { type: 'run.resume', runId });
    expect(plain.status).toBe(409);
    expect(plain.body.error?.code).toBe('run_not_interrupted');
  });
});

describe('run progress stream — the UI watches what the run does (AC-9 · W2)', () => {
  interface SseFrame {
    event: string;
    data: Record<string, unknown>;
  }

  /** Reads the SSE endpoint until `stop` or the stream ends; always cancels. */
  async function collectSse(
    response: Response,
    stop: (frames: SseFrame[]) => boolean,
    timeoutMs = 8000,
  ): Promise<SseFrame[]> {
    const frames: SseFrame[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let current = 'message';
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf('\n\n');
        while (cut !== -1) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          cut = buffer.indexOf('\n\n');
          let data = '';
          for (const line of block.split('\n')) {
            const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
            if (trimmed.startsWith('event:')) current = trimmed.slice(6).trim();
            else if (trimmed.startsWith('data:')) data += trimmed.slice(5).trim();
          }
          if (data !== '') {
            frames.push({ event: current, data: JSON.parse(data) as Record<string, unknown> });
            current = 'message';
          }
        }
        if (stop(frames)) break;
      }
      return frames;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  it('replays a snapshot, streams live progress, and closes at the terminal state', async () => {
    const model = scriptedModel([
      { toolCalls: [{ id: 't1', name: 'ask_human', input: { question: '예산 한도는?' } }] },
      { stream: ['마무리 초안 ', 'x'.repeat(130)], delayMs: 350, text: FINAL.text },
    ]);
    const daemon = await boot(model);
    const { projectId, ideaId } = await seed(daemon);

    const started = await command(daemon, projectId, {
      type: 'run.start',
      taskId: ideaId,
      agent: 'researcher',
      mode: 'research',
    });
    const runId = runIdOf(started);
    await waitRun(daemon, projectId, runId, (run) => run.state === 'needs_input');

    // a UI connecting mid-run: snapshot first — the log-so-far included
    const response = await fetch(`${daemon.url}/api/projects/${projectId}/runs/${runId}/events`, {
      headers: { origin: 'http://localhost:5173' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    // the stream's first word is the snapshot — and nothing else, because
    // nothing has moved yet: deltas only arrive when the run does.
    const frames = await collectSse(
      response,
      (list) => list.some((frame) => frame.event === 'snapshot'),
    );

    const snapshot = frames.find((frame) => frame.event === 'snapshot');
    expect(snapshot).toBeDefined();
    expect((snapshot!.data.run as RunRecord).state).toBe('needs_input');
    const snapshotLog = snapshot!.data.log as Array<{ stream: string; line: string }>;
    expect(snapshotLog.some((line) => line.stream === 'event' && line.line.includes('예산 한도는?'))).toBe(true);
    expect(frames.some((frame) => frame.event === 'run')).toBe(false); // parked — nothing to report

    // a second watcher: the person answers mid-stream, and the run's own
    // writes must reach the client as live `run`/`log` deltas.
    const liveResponse = await fetch(`${daemon.url}/api/projects/${projectId}/runs/${runId}/events`, {
      headers: { origin: 'http://localhost:5173' },
    });
    const livePromise = collectSse(
      liveResponse,
      (list) => list.some((frame) => frame.event === 'run' && frame.data.state === 'review'),
    );
    // let the snapshot pass, then wake the run
    await new Promise((resolve) => setTimeout(resolve, 300));
    await command(daemon, projectId, { type: 'run.answer', runId, text: '예산 3만원까지' });
    const live = await livePromise;

    const states = live.filter((f) => f.event === 'run').map((f) => f.data.state);
    expect(states).toContain('running');
    expect(states).toContain('review');
    // streamed stdout lands as log deltas *before* the run event — progress
    // the person saw while the turn was still writing (the 130-char flush).
    const logLines = live.filter((f) => f.event === 'log').map((f) => String(f.data.line ?? ''));
    expect(logLines.some((line) => line.includes('마무리 초안'))).toBe(true);
    const stdoutIndex = live.findIndex(
      (f) => f.event === 'log' && String(f.data.line ?? '').includes('x'.repeat(60)),
    );
    const reviewIndex = live.findIndex((f) => f.event === 'run' && f.data.state === 'review');
    expect(stdoutIndex).toBeGreaterThan(-1);
    expect(reviewIndex).toBeGreaterThan(-1);
    expect(stdoutIndex).toBeLessThan(reviewIndex);

    // cancel stops promptly — the stream reports it and closes (EOF)
    await command(daemon, projectId, { type: 'run.cancel', runId });
    const tail = await collectSse(
      await fetch(`${daemon.url}/api/projects/${projectId}/runs/${runId}/events`, {
        headers: { origin: 'http://localhost:5173' },
      }),
      () => false,
      3000,
    );
    const tailRun = tail.filter((frame) => frame.event === 'run');
    const lastRecord = tailRun.at(-1)?.data as RunRecord | undefined;
    expect(
      lastRecord?.state ?? (tail.find((f) => f.event === 'snapshot')!.data.run as RunRecord).state,
    ).toBe('cancelled');
  });

  it('a stream for a missing or foreign run is refused like the detail route', async () => {
    const daemon = await boot(scriptedModel([FINAL]));
    const { projectId, ideaId } = await seed(daemon);
    const started = await command(daemon, projectId, {
      type: 'run.start',
      taskId: ideaId,
      agent: 'researcher',
    });
    const runId = runIdOf(started);

    const missing = await fetch(`${daemon.url}/api/projects/${projectId}/runs/R_missing00/events`, {
      headers: { origin: 'http://localhost:5173' },
    });
    expect(missing.status).toBe(404);

    const other = await api<{ project: Project }>(daemon, '/api/projects', {
      method: 'POST',
      body: { name: '다른 프로젝트' },
    });
    const foreign = await fetch(
      `${daemon.url}/api/projects/${other.body.project.id}/runs/${runId}/events`,
      { headers: { origin: 'http://localhost:5173' } },
    );
    expect(foreign.status).toBe(404);
    await command(daemon, projectId, { type: 'run.cancel', runId });
  });
});

describe('a daemon restart under a live run (AC-2 · checkpoint)', () => {
  it('marks the run interrupted, and answering it after the restart finishes the card', async () => {
    const model = scriptedModel([
      { toolCalls: [{ id: 't1', name: 'ask_human', input: { question: '범위는 국내만?' } }] },
      FINAL,
    ]);
    const daemonA = await boot(model);
    const { projectId, ideaId } = await seed(daemonA);

    const started = await command(daemonA, projectId, {
      type: 'run.start',
      taskId: ideaId,
      agent: 'researcher',
    });
    const runId = runIdOf(started);
    await waitRun(daemonA, projectId, runId, (run) => run.state === 'needs_input');

    // the process dies — the question is still open
    await daemonA.close();

    // a new daemon (a fresh model double) sees the run interrupted
    const model2 = scriptedModel([FINAL]);
    const daemonB = await boot(model2);
    const afterRestart = await api<{ run: RunRecord }>(daemonB, `/api/projects/${projectId}/runs/${runId}`);
    expect(afterRestart.body.run.interrupted).toBe(true);
    expect(afterRestart.body.run.state).toBe('needs_input');

    // resume clears the flag; the question still stands, and the answer finishes it
    await command(daemonB, projectId, { type: 'run.resume', runId });
    const resumed = await api<{ run: RunRecord }>(daemonB, `/api/projects/${projectId}/runs/${runId}`);
    expect(resumed.body.run.interrupted).toBe(false);

    await command(daemonB, projectId, { type: 'run.answer', runId, text: '국내 + 일본' });
    const done = await waitRun(daemonB, projectId, runId, (run) => run.state === 'review' || run.state === 'done');
    expect(['review', 'done']).toContain(done.state);
  });

  it('a finished run stays finished — a leftover restart flag cannot revive it over HTTP (Major-1)', async () => {
    const model = scriptedModel([
      { toolCalls: [{ id: 't1', name: 'ask_human', input: { question: '범위는 국내만?' } }] },
    ]);
    const daemonA = await boot(model);
    const { projectId, ideaId } = await seed(daemonA);

    const started = await command(daemonA, projectId, {
      type: 'run.start',
      taskId: ideaId,
      agent: 'researcher',
    });
    const runId = runIdOf(started);
    await waitRun(daemonA, projectId, runId, (run) => run.state === 'needs_input');

    // the process dies with the question open; the restart lands the flag
    await daemonA.close();
    const daemonB = await boot(scriptedModel([FINAL]));
    const flagged = await api<{ run: RunRecord }>(daemonB, `/api/projects/${projectId}/runs/${runId}`);
    expect(flagged.body.run.interrupted).toBe(true);

    // the person answers (acknowledging the restart) and adopts the card: done
    await command(daemonB, projectId, { type: 'run.answer', runId, text: '국내만' });
    await waitRun(daemonB, projectId, runId, (run) => run.state === 'review');
    const withCard = await api<{ project: Project }>(daemonB, `/api/projects/${projectId}`);
    const card = withCard.body.project.proposals.find((proposal) => proposal.authorId === runId);
    expect(card).toBeDefined();
    await command(daemonB, projectId, {
      type: 'proposal.adopt',
      docId: card!.docId,
      proposalId: card!.id,
    });
    const done = await waitRun(daemonB, projectId, runId, (run) => run.state === 'done');
    expect(done.endedAt).not.toBeNull();

    // the endpoint holds: run.resume on the finished run is refused (AC-2),
    // even if a restart flag survived somewhere, and the run stays done
    const revived = await command(daemonB, projectId, { type: 'run.resume', runId });
    expect(revived.status).toBeGreaterThanOrEqual(400);
    const after = await api<{ run: RunRecord }>(daemonB, `/api/projects/${projectId}/runs/${runId}`);
    expect(after.body.run.state).toBe('done');
    expect(after.body.run.interrupted).toBe(false);
  });
});
