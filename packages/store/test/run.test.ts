import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { Proposal } from '@spec-studio/protocol';
import { AiBriefDraftSchema } from '@spec-studio/protocol';
import { openSqliteStore, type SqliteStore } from '../src';

/**
 * E3 W1 — the run surface behind its commands. The person's lifecycle
 * commands are applied by the store against `run`/`run_log` (§4.2), machine
 * transitions come through the run port the daemon holds, and the one thing
 * AC-1 needs from the ledger — a run-linked adoption stamped `ai:<runId>` —
 * is proven here at the row level.
 */

let dir = '';
let file = '';
let clock = 0;
const stores: SqliteStore[] = [];

function tick(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 10, 22, 6, 0, clock)).toISOString();
}

function open(): SqliteStore {
  const store = openSqliteStore({ file, clock: tick, deviceId: 'dev-a' });
  stores.push(store);
  return store;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spec-studio-run-'));
  file = join(dir, 'graph.db');
  clock = 0;
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seedIdeaAndRun(store: SqliteStore): Promise<{ projectId: string; runId: string; ideaId: string }> {
  const project = await store.createProject({ name: '런 테스트', id: 'PRJ_runtest0001' });
  const captured = await store.execute(project.id, {
    type: 'idea.capture',
    text: '경쟁 브리프 자동 조사 아이디어',
  });
  const ideaId = (captured.events[0] as { idea: { id: string } }).idea.id;
  // a research doc must exist for the brief card the run will emit
  await store.execute(project.id, { type: 'doc.create', title: '리서치', kind: 'research' });
  const started = await store.execute(project.id, {
    type: 'run.start',
    taskId: ideaId,
    agent: 'researcher',
    mode: 'research',
  });
  const runId = (started.events[0] as { run: { id: string } }).run.id;
  return { projectId: project.id, runId, ideaId };
}

function db(store: SqliteStore): DatabaseSync {
  return store.database;
}

describe('run lifecycle commands (§4.2)', () => {
  it('run.start writes a queued run, an agent thread, its event, and a ledger row', async () => {
    const store = open();
    const { projectId, runId } = await seedIdeaAndRun(store);
    const database = db(store);

    const run = database.prepare('SELECT * FROM run WHERE id = ?').get(runId) as Record<string, unknown>;
    expect(run['state']).toBe('queued');
    expect(run['mode']).toBe('research');
    expect(run['interrupted']).toBe(0);

    const thread = database.prepare('SELECT * FROM thread WHERE id = ?').get(`agent:${runId}`) as Record<
      string,
      unknown
    >;
    expect(thread['kind']).toBe('agent');

    const events = database
      .prepare("SELECT type, payload FROM event WHERE thread_id = ? ORDER BY seq")
      .all(`agent:${runId}`) as Array<{ type: string; payload: string }>;
    expect(events.map((row) => row.type)).toContain('run.started');

    const op = database
      .prepare('SELECT kind, actor, before, after, device_id FROM op_log ORDER BY seq DESC LIMIT 1')
      .get() as Record<string, unknown>;
    expect(op['kind']).toBe('run.start');
    expect(op['actor']).toBe('person:owner');
    // `before` rides the ledger's JSON convention (`"null"`, as doc.delete does).
    expect(JSON.parse(op['before'] as string)).toBeNull();
    expect(JSON.parse(op['after'] as string).id).toBe(runId);
    expect(op['device_id']).toBe('dev-a');

    expect(projectId).toBe('PRJ_runtest0001');
  });

  it('refuses what the state machine refuses, with the run untouched', async () => {
    const store = open();
    const { projectId, runId } = await seedIdeaAndRun(store);
    // machine walks to needs_input first (the daemon's half)
    store.transitionRun(runId, 'running');
    store.transitionRun(runId, 'needs_input');

    await expect(
      store.execute(projectId, { type: 'run.answer', runId, text: '답' }),
    ).resolves.toBeDefined(); // legal here

    await expect(
      store.execute(projectId, { type: 'run.resume', runId }),
    ).rejects.toThrowError(/interrupted/);

    store.transitionRun(runId, 'running');
    store.transitionRun(runId, 'done');
    await expect(
      store.execute(projectId, { type: 'run.cancel', runId, reason: '늦었네' }),
    ).rejects.toThrowError(/이미 끝난/);
  });

  it('run.answer hands a needs_input run back to the queue and keeps the answer', async () => {
    const store = open();
    const { projectId, runId } = await seedIdeaAndRun(store);
    store.transitionRun(runId, 'running');
    store.transitionRun(runId, 'needs_input');

    await store.execute(projectId, { type: 'run.answer', runId, text: '예산 3만원까지' });

    const run = db(store).prepare('SELECT state, outward_at FROM run WHERE id = ?').get(runId) as Record<
      string,
      unknown
    >;
    expect(run['state']).toBe('queued');
    expect(run['outward_at']).toBeNull();

    const answer = db(store)
      .prepare("SELECT line FROM run_log WHERE run_id = ? AND stream = 'event' ORDER BY seq")
      .all(runId) as Array<{ line: string }>;
    expect(answer.some((row) => row.line.includes('예산 3만원까지'))).toBe(true);
  });

  it('run.cancel is terminal and journaled with before/after', async () => {
    const store = open();
    const { projectId, runId } = await seedIdeaAndRun(store);
    await store.execute(projectId, { type: 'run.cancel', runId, reason: '그만' });
    const run = db(store).prepare('SELECT state, ended_at FROM run WHERE id = ?').get(runId) as Record<
      string,
      unknown
    >;
    expect(run['state']).toBe('cancelled');
    expect(run['ended_at']).not.toBeNull();
    const op = db(store)
      .prepare("SELECT kind, before, after FROM op_log WHERE kind = 'run.cancel'")
      .get() as Record<string, unknown>;
    expect(JSON.parse(op['before'] as string).state).toBe('queued');
    expect(JSON.parse(op['after'] as string).state).toBe('cancelled');
  });
});

describe('run port — the machine half (daemon surface)', () => {
  it('transitions, journals and checkpoints without touching the project', async () => {
    const store = open();
    const { runId } = await seedIdeaAndRun(store);

    const running = store.transitionRun(runId, 'running');
    expect(running.state).toBe('running');
    expect(running.startedAt).not.toBeNull();

    store.appendRunLog(runId, 'stdout', '조사 시작');
    store.appendRunLog(runId, 'event', JSON.stringify({ tool: 'echo', blocked: false }));
    store.saveCheckpoint(runId, 1, JSON.stringify({ messages: [{ role: 'user', text: '아이디어' }] }));
    store.saveCheckpoint(runId, 2, JSON.stringify({ messages: [{ role: 'user', text: '아이디어' }, { role: 'assistant', text: '' }] }));

    const latest = store.latestCheckpoint(runId);
    expect(latest?.seq).toBe(2);

    const lines = store.runLog(runId);
    expect(lines.map((line) => line.stream)).toEqual(['event', 'stdout', 'event']);
  });

  it('marks live runs interrupted on restart and lists them (AC-2 restore)', async () => {
    const store = open();
    const { runId } = await seedIdeaAndRun(store);
    store.transitionRun(runId, 'running');

    const interrupted = store.markInterruptedRuns();
    expect(interrupted).toBe(1);
    const listed = store.listRuns();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.interrupted).toBe(true);
    expect(listed[0]?.state).toBe('running');
  });

  it('resume clears the flag and requeues live work', async () => {
    const store = open();
    const { projectId, runId } = await seedIdeaAndRun(store);
    store.transitionRun(runId, 'running');
    store.markInterruptedRuns();
    await store.execute(projectId, { type: 'run.resume', runId });
    const run = db(store).prepare('SELECT state, interrupted FROM run WHERE id = ?').get(runId) as Record<
      string,
      unknown
    >;
    expect(run['state']).toBe('queued');
    expect(run['interrupted']).toBe(0);
  });
});

describe('AC-1 — the run leaves its name on the adoption, nothing else', () => {
  const draft = AiBriefDraftSchema.parse({
    title: '경쟁 브리프',
    summary: '한 줄 요약',
    claims: [{ text: '근거 없는 주장', ungrounded: true }],
  });

  it('a run-linked proposal persists author_id and its adoption is stamped ai:<runId>', async () => {
    const store = open();
    const { projectId, runId } = await seedIdeaAndRun(store);
    const doc = (await store.readProject(projectId))?.docs[0];
    expect(doc).toBeDefined();

    await store.execute(projectId, {
      type: 'proposal.create',
      docId: doc!.id,
      draft,
      source: 'llm',
      runId,
    });
    const proposal = (await store.readProject(projectId))?.proposals.at(-1) as Proposal;
    expect(proposal.authorId).toBe(runId);

    await store.execute(projectId, { type: 'proposal.adopt', docId: doc!.id, proposalId: proposal.id });
    const op = db(store)
      .prepare('SELECT actor FROM op_log WHERE kind = ? ORDER BY seq DESC LIMIT 1')
      .get('proposal.adopt') as Record<string, unknown>;
    expect(op['actor']).toBe(`ai:${runId}`);
  });

  it('a person proposal keeps person:* — the stamp is provenance, not a default', async () => {
    const store = open();
    const { projectId } = await seedIdeaAndRun(store);
    const doc = (await store.readProject(projectId))?.docs[0];
    await store.execute(projectId, { type: 'proposal.create', docId: doc!.id, draft, source: 'rule' });
    const proposal = (await store.readProject(projectId))?.proposals.at(-1) as Proposal;
    expect(proposal.authorId).toBeNull();
    await store.execute(projectId, { type: 'proposal.adopt', docId: doc!.id, proposalId: proposal.id });
    const op = db(store)
      .prepare('SELECT actor FROM op_log WHERE kind = ? ORDER BY seq DESC LIMIT 1')
      .get('proposal.adopt') as Record<string, unknown>;
    expect(op['actor']).toBe('person:owner');
  });
});
