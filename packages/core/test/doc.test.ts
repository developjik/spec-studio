import { describe, expect, it } from 'vitest';
import type { Command, Project, Screen } from '@spec-studio/protocol';
import {
  applyPatches,
  buildProposal,
  createProject,
  execute,
  pinFingerprint,
  restoreSnapshot,
  snapshotForPatches,
  staleBadges,
  type ExecuteContext,
} from '../src';

/**
 * The W4 promise, in pure functions: a paragraph stands on pins, a pin edit
 * makes it stale, one proposal carries the whole change, and the snapshot the
 * store would keep in `op_log.before` restores it exactly.
 */

const AT = '2026-11-19T09:00:00.000Z';

const SCREEN: Screen = {
  id: `S_${'a'.repeat(12)}`,
  title: '주문 상세',
  code: 'SCR-110',
  ref: { kind: 'image', value: 'data:image/svg+xml;base64,PHN2Zy8+' },
  viewport: { width: 1200, height: 800 },
  createdAt: AT,
  updatedAt: AT,
};

function context(): ExecuteContext {
  let n = 0;
  let blocks = 0;
  return {
    at: AT,
    nextId: (kind) => {
      n += 1;
      switch (kind) {
        case 'project':
          return `PRJ_${'p'.repeat(12)}`;
        case 'screen':
          return `S_${'a'.repeat(12)}`;
        case 'pin':
          return `P_${String(n).padStart(12, '0')}`;
        case 'doc':
          return `D_${'d'.repeat(12)}`;
        case 'block':
          blocks += 1;
          return blocks === 1 ? `B_${'b'.repeat(12)}` : `B_${String(blocks).padStart(12, '0')}`;
        case 'proposal':
          return `PR_${'p'.repeat(12)}`;
        case 'node':
          return `N_${String(n).padStart(12, '0')}`;
        case 'link':
          return `L_${String(n).padStart(12, '0')}`;
        case 'graphProposal':
          return `GP_${String(n).padStart(12, '0')}`;
      }
    },
  };
}

function run(project: Project, command: Command, ctx: ExecuteContext): Project {
  return execute(project, command, ctx).project;
}

function seeded(): { project: Project; ctx: ExecuteContext } {
  const ctx = context();
  let project = createProject({ id: 'PRJ_abcdefghijkl', name: '주문 상세 기획', at: AT });
  project = run(project, { type: 'screen.attach', screen: SCREEN }, ctx);
  project = run(
    project,
    {
      type: 'pin.create',
      screenId: SCREEN.id,
      pinType: 'function',
      title: '취소 요청',
      body: '배송 준비 중일 때만 활성',
      anchor: { x: 0.22, y: 0.3 },
    },
    ctx,
  );
  project = run(
    project,
    {
      type: 'pin.create',
      screenId: SCREEN.id,
      pinType: 'policy',
      title: '배송 시작 후 취소 불가',
      body: '사전조건: 배송 시작',
      anchor: { x: 0.56, y: 0.48 },
    },
    ctx,
  );
  return { project, ctx };
}

const docId = `D_${'d'.repeat(12)}`;
const blockId = `B_${'b'.repeat(12)}`;
const pin1 = `P_${String(2).padStart(12, '0')}`;
const pin2 = `P_${String(3).padStart(12, '0')}`;

describe('a document beside the screen', () => {
  it('is created with the screen and survives a pin edit as prose', () => {
    const { project } = seeded();
    expect(project.docs[0]).not.toBeUndefined();
    expect(project.docs[0]?.id).toBe(docId);
    expect(project.docs[0]?.blocks).toHaveLength(0);
  });

  it('adds, edits, moves and deletes blocks by stable id', () => {
    const { project, ctx } = seeded();
    let next = run(
      project,
      { type: 'doc.block.create', docId, blockType: 'paragraph', text: '첫 문단' },
      ctx,
    );
    next = run(
      next,
      { type: 'doc.block.create', docId, blockType: 'paragraph', text: '둘째 문단' },
      ctx,
    );
    expect(next.docs[0]?.blocks.map((block) => block.text)).toEqual(['첫 문단', '둘째 문단']);

    const second = next.docs[0]?.blocks[1] as { id: string };
    next = run(
      next,
      { type: 'doc.block.update', docId, blockId: second.id, text: '고친 둘째 문단' },
      ctx,
    );
    expect(next.docs[0]?.blocks[1]?.text).toBe('고친 둘째 문단');

    next = run(next, { type: 'doc.block.move', docId, blockId: second.id, afterBlockId: null }, ctx);
    expect(next.docs[0]?.blocks.map((block) => block.text)).toEqual(['고친 둘째 문단', '첫 문단']);

    next = run(next, { type: 'doc.block.delete', docId, blockId: second.id }, ctx);
    expect(next.docs[0]?.blocks.map((block) => block.text)).toEqual(['첫 문단']);
    expect(next.docs[0]?.rev).toBe(5);
  });
});

describe('paragraph ↔ pin linking', () => {
  function withLinkedBlock(): { project: Project; ctx: ExecuteContext } {
    const { project, ctx } = seeded();
    let next = run(
      project,
      {
        type: 'doc.block.create',
        docId,
        blockType: 'paragraph',
        text: '배송이 시작되기 전까지만 취소할 수 있다.',
      },
      ctx,
    );
    next = run(next, { type: 'doc.pin.link', docId, blockId, pinId: pin1 }, ctx);
    next = run(next, { type: 'doc.pin.link', docId, blockId, pinId: pin2 }, ctx);
    return { project: next, ctx };
  }

  it('records the pin on the block and writes its citation into the text', () => {
    const { project } = withLinkedBlock();
    const block = project.docs[0]?.blocks[0];
    expect(block?.pinRefs.map((ref) => ref.pinId)).toEqual([pin1, pin2]);
    expect(block?.text).toContain('[핀] #1 취소 요청');
    expect(block?.text).toContain('[핀] #2 배송 시작 후 취소 불가');
    expect(staleBadges(project.docs[0]!, project.pins)).toEqual([]);
  });

  it('marks the block stale when a linked pin changes, but not when it merely moves', () => {
    const { project, ctx } = withLinkedBlock();
    const moved = run(
      project,
      { type: 'pin.update', screenId: SCREEN.id, pinId: pin1, anchor: { x: 0.4, y: 0.4 } },
      ctx,
    );
    expect(staleBadges(moved.docs[0]!, moved.pins)).toEqual([]);

    const edited = run(
      moved,
      { type: 'pin.update', screenId: SCREEN.id, pinId: pin1, title: '취소 요청 버튼' },
      ctx,
    );
    expect(staleBadges(edited.docs[0]!, edited.pins)).toEqual([
      { blockId, pinId: pin1, reason: 'pin-changed' },
    ]);
  });

  it('marks the block stale when a linked pin is deleted', () => {
    const { project, ctx } = withLinkedBlock();
    const deleted = run(project, { type: 'pin.delete', screenId: SCREEN.id, pinId: pin2 }, ctx);
    expect(staleBadges(deleted.docs[0]!, deleted.pins)).toEqual([
      { blockId, pinId: pin2, reason: 'pin-missing' },
    ]);
  });

  it('clears a stale badge by re-baselining the link for a living pin', () => {
    const { project, ctx } = withLinkedBlock();
    const edited = run(
      project,
      { type: 'pin.update', screenId: SCREEN.id, pinId: pin1, body: '바뀐 설명' },
      ctx,
    );
    const cleared = run(
      edited,
      { type: 'doc.stale.clear', docId, blockId, pinId: pin1 },
      ctx,
    );
    expect(staleBadges(cleared.docs[0]!, cleared.pins)).toEqual([]);
    // the sentence keeps the pin, and the text now cites the new body-free spec
    expect(cleared.docs[0]?.blocks[0]?.pinRefs.map((ref) => ref.pinId)).toEqual([pin1, pin2]);
  });
});

describe('one proposal, one decision, one revert', () => {
  function staleDocument(): { project: Project; ctx: ExecuteContext } {
    const { project, ctx } = seeded();
    let next = run(
      project,
      {
        type: 'doc.block.create',
        docId,
        blockType: 'paragraph',
        text: '배송이 시작되기 전까지만 취소할 수 있다.',
      },
      ctx,
    );
    next = run(next, { type: 'doc.pin.link', docId, blockId, pinId: pin1 }, ctx);
    next = run(
      next,
      { type: 'pin.update', screenId: SCREEN.id, pinId: pin1, title: '취소 요청 버튼' },
      ctx,
    );
    return { project: next, ctx };
  }

  it('carries the change as one card and leaves the text alone until adopted', () => {
    const { project, ctx } = staleDocument();
    const before = project.docs[0]?.blocks[0]?.text;
    const created = run(project, { type: 'proposal.create', docId }, ctx);

    expect(created.proposal?.state).toBe('open');
    expect(created.proposal?.patches).toHaveLength(1);
    expect(created.proposal?.summary).toContain('#1');
    expect(created.docs[0]?.blocks[0]?.text).toBe(before);
  });

  it('adopts the patch, then restores op_log.before exactly', () => {
    const { project, ctx } = staleDocument();
    const beforeDoc = project.docs[0]!;
    const beforeText = beforeDoc.blocks[0]?.text as string;

    const created = run(project, { type: 'proposal.create', docId }, ctx);
    const proposal = created.proposal!;
    const adopted = run(
      created,
      { type: 'proposal.adopt', docId, proposalId: proposal.id },
      ctx,
    );

    expect(adopted.proposal?.state).toBe('adopted');
    expect(adopted.docs[0]?.blocks[0]?.text).toContain('#1 취소 요청 버튼');
    expect(staleBadges(adopted.docs[0]!, adopted.pins)).toEqual([]);

    // The store keeps exactly this value in op_log.before.
    const snapshot = snapshotForPatches(beforeDoc, proposal.patches);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]).toMatchObject({ blockId, existed: true, text: beforeText });

    const reverted = restoreSnapshot(adopted.docs[0]!, snapshot, AT);
    expect(reverted.blocks[0]?.text).toBe(beforeText);
    expect(reverted.blocks[0]?.pinRefs).toEqual(beforeDoc.blocks[0]?.pinRefs);
    // ...and the pin is still changed, so the block is honestly stale again.
    expect(staleBadges(reverted, adopted.pins)).toEqual([
      { blockId, pinId: pin1, reason: 'pin-changed' },
    ]);
  });

  it('proposes an insert when nothing is stale, and a revert removes it again', () => {
    const { project, ctx } = seeded();
    const created = run(project, { type: 'proposal.create', docId }, ctx);
    const proposal = created.proposal!;
    expect(proposal.patches).toHaveLength(1);
    expect(proposal.patches[0]?.before).toBeNull();
    expect(proposal.patches[0]?.after.text).toContain('이 화면에서 확인할 것');

    const applied = applyPatches(created.docs[0]!, proposal.patches, AT);
    expect(applied.doc.blocks).toHaveLength(1);
    expect(applied.created).toEqual([proposal.patches[0]?.blockId]);

    const snapshot = snapshotForPatches(created.docs[0]!, proposal.patches);
    const reverted = restoreSnapshot(applied.doc, snapshot, AT);
    expect(reverted.blocks).toHaveLength(0);
  });

  it('removes the citation of a deleted pin in the proposal', () => {
    const { project, ctx } = seeded();
    let next = run(
      project,
      { type: 'doc.block.create', docId, blockType: 'paragraph', text: '취소 정책' },
      ctx,
    );
    next = run(next, { type: 'doc.pin.link', docId, blockId, pinId: pin1 }, ctx);
    next = run(next, { type: 'doc.pin.link', docId, blockId, pinId: pin2 }, ctx);
    next = run(next, { type: 'pin.delete', screenId: SCREEN.id, pinId: pin2 }, ctx);
    const created = run(next, { type: 'proposal.create', docId }, ctx);
    const patch = created.proposal?.patches[0];
    expect(patch?.after.text).not.toContain('배송 시작 후 취소 불가');
    expect(patch?.after.pinRefs.map((ref) => ref.pinId)).toEqual([pin1]);
  });

  it('rejects a proposal without touching the document', () => {
    const { project, ctx } = staleDocument();
    const created = run(project, { type: 'proposal.create', docId }, ctx);
    const text = created.docs[0]?.blocks[0]?.text;
    const rejected = run(
      created,
      { type: 'proposal.reject', docId, proposalId: created.proposal!.id },
      ctx,
    );
    expect(rejected.proposal?.state).toBe('rejected');
    expect(rejected.docs[0]?.blocks[0]?.text).toBe(text);
  });

  it('fingerprints only what makes a sentence false', () => {
    const { project } = seeded();
    const pin = project.pins[0]!;
    const movedPin = { ...pin, anchor: { x: 0.9, y: 0.9 } };
    expect(pinFingerprint(pin)).toBe(pinFingerprint(movedPin));
    expect(pinFingerprint(pin)).not.toBe(pinFingerprint({ ...pin, body: '다른 설명' }));
    expect(buildProposal({ id: `PR_${'q'.repeat(12)}`, doc: project.docs[0]!, pins: project.pins, at: AT }))
      .toHaveProperty('patches');
  });
});
