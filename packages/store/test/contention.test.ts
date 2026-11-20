import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project, Screen } from '@spec-studio/protocol';
import { openSqliteStore, type SqliteStore } from '../src';

/**
 * MJ-1: with a registry of docs, each doc keeps its own proposal on the
 * table. Deciding one doc's card must not strand another doc's, and a doc
 * never holds two open cards at once.
 */

const SCREEN: Screen = {
  id: `S_${'c'.repeat(12)}`,
  title: '주문 상세',
  code: 'SCR-110',
  ref: { kind: 'image', value: 'data:image/svg+xml;base64,PHN2Zy8+' },
  viewport: { width: 1200, height: 800 },
  createdAt: '2026-11-19T09:00:00.000Z',
  updatedAt: '2026-11-19T09:00:00.000Z',
};

let dir = '';
let file = '';
let clock = 0;
const stores: SqliteStore[] = [];

function tick(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 10, 19, 12, 0, clock)).toISOString();
}

function open(): SqliteStore {
  const store = openSqliteStore({ file, clock: tick });
  stores.push(store);
  return store;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spec-studio-contention-'));
  file = join(dir, 'graph.db');
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Two docs with one paragraph each — the smallest table two cards can fight over. */
async function contended(
  store: SqliteStore,
): Promise<{ projectId: string; a: string; b: string; blockA: string; blockB: string }> {
  const project = await store.createProject({ name: '주문 상세 기획', id: 'PRJ_contention01' });
  await store.execute(project.id, { type: 'screen.attach', screen: SCREEN });
  const a = (await store.readProject(project.id))?.docs[0]?.id as string;
  const research = await store.execute(project.id, {
    type: 'doc.create',
    title: '리서치 노트',
    kind: 'research',
  });
  const b = research.project.docs[1]?.id as string;
  const blockA = await store.execute(project.id, {
    type: 'doc.block.create',
    docId: a,
    blockType: 'paragraph',
    text: '취소는 배송 준비 중에만 가능하다.',
  });
  const blockB = await store.execute(project.id, {
    type: 'doc.block.create',
    docId: b,
    blockType: 'paragraph',
    text: '경쟁 서비스는 취소가 하루만 가능했다.',
  });
  return {
    projectId: project.id,
    a,
    b,
    blockA: blockA.project.docs.find((doc) => doc.id === a)?.blocks[0]?.id as string,
    blockB: blockB.project.docs.find((doc) => doc.id === b)?.blocks[0]?.id as string,
  };
}

/** A minimal `AiDocDraftSchema` payload: rewrite one block, cite no pins. */
const draftFor = (blockId: string, text: string) => ({
  summary: '문단을 다시 쓴다',
  patches: [{ blockId, text, pins: [] }],
});

describe('proposals across docs (MJ-1)', () => {
  it('adopts doc A’s card after doc B’s was decided — the s8 scenario', async () => {
    const store = open();
    const { projectId, a, b, blockA, blockB } = await contended(store);

    const createdA = await store.execute(projectId, {
      type: 'proposal.create',
      docId: a,
      draft: draftFor(blockA, '취소는 배송 준비 중에만 가능하다. 단, 당일 취소는 하루 1회.'),
    });
    const cardA = createdA.project.proposals.find((p) => p.docId === a);
    expect(cardA?.state).toBe('open');

    const createdB = await store.execute(projectId, {
      type: 'proposal.create',
      docId: b,
      draft: draftFor(blockB, '경쟁 서비스는 취소가 이틀까지 가능했다.'),
    });
    expect(createdB.project.proposals).toHaveLength(2);
    const cardB = createdB.project.proposals.find((p) => p.docId === b);
    expect(cardB?.state).toBe('open');

    const rejectedB = await store.execute(projectId, {
      type: 'proposal.reject',
      docId: b,
      proposalId: cardB?.id as string,
    });
    expect(rejectedB.project.proposals.find((p) => p.docId === b)?.state).toBe('rejected');

    // was `proposal_missing` when the slot held only the newest card
    const adoptedA = await store.execute(projectId, {
      type: 'proposal.adopt',
      docId: a,
      proposalId: cardA?.id as string,
    });
    expect(adoptedA.project.docs.find((doc) => doc.id === a)?.blocks[0]?.text).toContain('하루 1회');

    const reloaded = (await store.readProject(projectId)) as Project;
    expect(reloaded.proposals.find((p) => p.docId === a)?.state).toBe('adopted');
    expect(reloaded.proposals.find((p) => p.docId === b)?.state).toBe('rejected');
    expect(reloaded.docs.find((doc) => doc.id === a)?.blocks[0]?.text).toContain('하루 1회');
    expect(reloaded.docs.find((doc) => doc.id === b)?.blocks[0]?.text).toBe(
      '경쟁 서비스는 취소가 하루만 가능했다.',
    );
  });

  it('rejects doc A’s card after doc B’s was rejected', async () => {
    const store = open();
    const { projectId, a, b, blockA, blockB } = await contended(store);

    const createdA = await store.execute(projectId, {
      type: 'proposal.create',
      docId: a,
      draft: draftFor(blockA, '취소는 배송 준비 중에만 가능하다. 단, 당일 취소는 하루 1회.'),
    });
    const cardA = createdA.project.proposals.find((p) => p.docId === a);
    const createdB = await store.execute(projectId, {
      type: 'proposal.create',
      docId: b,
      draft: draftFor(blockB, '경쟁 서비스는 취소가 이틀까지 가능했다.'),
    });
    const cardB = createdB.project.proposals.find((p) => p.docId === b);

    await store.execute(projectId, { type: 'proposal.reject', docId: b, proposalId: cardB?.id as string });
    const rejectedA = await store.execute(projectId, {
      type: 'proposal.reject',
      docId: a,
      proposalId: cardA?.id as string,
    });
    expect(rejectedA.project.proposals.find((p) => p.docId === a)?.state).toBe('rejected');
  });

  it('retires a doc’s open card when a newer one lands, and reload shows only the latest', async () => {
    const store = open();
    const { projectId, a, blockA } = await contended(store);

    const first = await store.execute(projectId, {
      type: 'proposal.create',
      docId: a,
      draft: draftFor(blockA, '취소는 배송 준비 중에만 가능하다. 첫 제안.'),
    });
    const firstCard = first.project.proposals.find((p) => p.docId === a);

    const second = await store.execute(projectId, {
      type: 'proposal.create',
      docId: a,
      draft: draftFor(blockA, '취소는 배송 준비 중에만 가능하다. 둘째 제안.'),
    });
    const forA = second.project.proposals.filter((p) => p.docId === a);
    expect(forA).toHaveLength(2);
    expect(forA.at(-1)?.state).toBe('open');
    expect(forA[0]?.state).toBe('rejected');

    // the retirement is an event, like any refusal
    const events = store.database
      .prepare("SELECT type FROM event WHERE type LIKE 'proposal.%' ORDER BY seq")
      .all() as Array<{ type: string }>;
    expect(events.map((event) => event.type)).toEqual([
      'proposal.created',
      'proposal.rejected',
      'proposal.created',
    ]);

    // the file keeps the retired row as rejected; the reload shows only the latest per doc
    const row = store.database
      .prepare('SELECT state, decided_at FROM proposal WHERE id = ?')
      .get(firstCard?.id as string) as { state: string; decided_at: string };
    expect(row.state).toBe('rejected');
    expect(row.decided_at).not.toBeNull();

    const reloaded = (await store.readProject(projectId)) as Project;
    expect(reloaded.proposals).toHaveLength(1);
    expect(reloaded.proposals[0]?.id).toBe(forA.at(-1)?.id);
  });

  it('reverts the card the op_log names, not the doc’s older adopted one', async () => {
    const store = open();
    const { projectId, a, blockA } = await contended(store);

    const first = await store.execute(projectId, {
      type: 'proposal.create',
      docId: a,
      draft: draftFor(blockA, '첫째가 바꾼 문단.'),
    });
    const card1 = first.project.proposals.find((p) => p.docId === a);
    await store.execute(projectId, {
      type: 'proposal.adopt',
      docId: a,
      proposalId: card1?.id as string,
    });

    const second = await store.execute(projectId, {
      type: 'proposal.create',
      docId: a,
      draft: draftFor(blockA, '둘째가 다시 바꾼 문단.'),
    });
    const card2 = second.project.proposals.filter((p) => p.docId === a).at(-1);
    await store.execute(projectId, {
      type: 'proposal.adopt',
      docId: a,
      proposalId: card2?.id as string,
    });

    const reverted = await store.revert(projectId);
    // the array holds both adopted cards for the doc — the revert row's
    // payload.proposalId, not array position, names which one was undone.
    const states = store.database
      .prepare('SELECT id, state FROM proposal ORDER BY rowid')
      .all() as Array<{ id: string; state: string }>;
    expect(states.find((row) => row.id === card2?.id)?.state).toBe('rejected');
    expect(states.find((row) => row.id === card1?.id)?.state).toBe('adopted');
    const block = reverted.project.docs
      .find((doc) => doc.id === a)
      ?.blocks.find((row) => row.id === blockA);
    expect(block?.text).toBe('첫째가 바꾼 문단.');
  });

  it('still refuses a second decision on the same card', async () => {
    const store = open();
    const { projectId, a, blockA } = await contended(store);
    const created = await store.execute(projectId, {
      type: 'proposal.create',
      docId: a,
      draft: draftFor(blockA, '취소는 배송 준비 중에만 가능하다. 단, 당일 취소는 하루 1회.'),
    });
    const cardId = created.project.proposals[0]?.id as string;
    await store.execute(projectId, { type: 'proposal.reject', docId: a, proposalId: cardId });
    await expect(
      store.execute(projectId, { type: 'proposal.reject', docId: a, proposalId: cardId }),
    ).rejects.toThrow(/이미 결정된 제안/);
  });

  it('keeps refusing an adopt that names another doc’s card', async () => {
    const store = open();
    const { projectId, a, b, blockA, blockB } = await contended(store);
    const createdA = await store.execute(projectId, {
      type: 'proposal.create',
      docId: a,
      draft: draftFor(blockA, '취소는 배송 준비 중에만 가능하다. 단, 당일 취소는 하루 1회.'),
    });
    const cardA = createdA.project.proposals.find((p) => p.docId === a);
    const createdB = await store.execute(projectId, {
      type: 'proposal.create',
      docId: b,
      draft: draftFor(blockB, '경쟁 서비스는 취소가 이틀까지 가능했다.'),
    });
    const cardB = createdB.project.proposals.find((p) => p.docId === b);

    await expect(
      store.execute(projectId, { type: 'proposal.adopt', docId: a, proposalId: cardB?.id as string }),
    ).rejects.toThrow(/이 제안은 다른 문서의 것입니다/);
    // both cards are still on the table afterwards
    const reloaded = (await store.readProject(projectId)) as Project;
    expect(reloaded.proposals.find((p) => p.id === cardA?.id)?.state).toBe('open');
    expect(reloaded.proposals.find((p) => p.id === cardB?.id)?.state).toBe('open');
  });
});
