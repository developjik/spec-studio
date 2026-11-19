import { describe, expect, it } from 'vitest';
import {
  applyGraphProposal,
  evaluateMaturityLevel,
  extractGraphProposal,
  graphViewNodes,
  traceability,
} from '@spec-studio/core';
import {
  execute,
  createProject,
  type ExecuteContext,
  type ExecutionResult,
} from '@spec-studio/core';
import type { Command, Project, Screen } from '@spec-studio/protocol';

const AT = '2026-11-19T10:00:00.000Z';

const SCREEN: Screen = {
  id: `S_${'s'.repeat(12)}`,
  title: '주문 상세',
  code: 'SCR-110',
  ref: { kind: 'image', value: 'data:image/svg+xml;base64,PHN2Zy8+' },
  viewport: { width: 1200, height: 800 },
  createdAt: AT,
  updatedAt: AT,
};

function context(): ExecuteContext {
  let n = 0;
  const next = () => String(++n).padStart(12, '0');
  return {
    at: AT,
    nextId: (kind, nodeType) => {
      const suffix = next();
      switch (kind) {
        case 'project':
          return `PRJ_${'p'.repeat(12)}`;
        case 'screen':
          return SCREEN.id;
        case 'pin':
          return `P_${suffix}`;
        case 'doc':
          return `D_${'d'.repeat(12)}`;
        case 'block':
          return `B_${suffix}`;
        case 'proposal':
          return `PR_${suffix}`;
        case 'node':
          return nodeType === 'contract' ? `C_${suffix}` : nodeType === 'qa' ? `V_${suffix}` : `N_${suffix}`;
        case 'link':
          return `L_${suffix}`;
        case 'graphProposal':
          return `GP_${suffix}`;
      }
    },
  };
}

function run(project: Project, command: Command, ctx: ExecuteContext): ExecutionResult {
  return execute(project, command, ctx);
}

function seeded(): { project: Project; ctx: ExecuteContext } {
  const ctx = context();
  let project = createProject({ id: 'PRJ_abcdefghijkl', name: '주문 상세', at: AT });
  project = run(project, { type: 'screen.attach', screen: SCREEN }, ctx).project;
  const pins: Array<'function' | 'policy' | 'exception'> = ['function', 'policy', 'exception'];
  pins.forEach((pinType, index) => {
    project = run(
      project,
      {
        type: 'pin.create',
        screenId: SCREEN.id,
        pinType,
        title: ['취소 요청', '배송 시작 후 취소 불가', '재고 없음 안내'][index]!,
        body: ['배송 준비 중일 때만 활성', '사전조건: 배송 시작', '재고 0이면 버튼 비활성'][index]!,
        anchor: { x: 0.2 + index * 0.2, y: 0.3 },
      },
      ctx,
    ).project;
  });
  return { project, ctx };
}

describe('the six-node graph', () => {
  it('shows screens, pins and the four editable kinds as one list', () => {
    const { project, ctx } = seeded();
    const types = graphViewNodes(project).map((node) => node.type);
    expect(types).toEqual(['screen', 'pin', 'pin', 'pin']);
    const withNode = run(project, { type: 'node.create', nodeType: 'req', title: '취소 조건', body: '' }, ctx);
    expect(graphViewNodes(withNode.project).map((node) => node.type)).toEqual([
      'screen',
      'pin',
      'pin',
      'pin',
      'req',
    ]);
  });

  it('accepts the seven named links only where the ends fit', () => {
    const { project, ctx } = seeded();
    const [fn, policy] = project.pins;
    const req = run(project, { type: 'node.create', nodeType: 'req', title: '취소 요청', body: '' }, ctx).project;
    const created = run(req, { type: 'link.create', linkType: 'implements', src: fn!.id, dst: req.graph.nodes[0]!.id }, ctx);
    expect(created.project.graph.links).toHaveLength(1);
    expect(created.events[0]?.type).toBe('link.created');

    expect(() =>
      run(
        created.project,
        { type: 'link.create', linkType: 'governs', src: policy!.id, dst: req.graph.nodes[0]!.id },
        ctx,
      ),
    ).toThrow(/연결할 수 없습니다/);
  });

  it('marks links suspect when a pin it names is rewritten, and clears on ack', () => {
    const { project, ctx } = seeded();
    const fn = project.pins[0]!;
    const withReq = run(project, { type: 'node.create', nodeType: 'req', title: '취소 요청', body: '' }, ctx).project;
    const reqId = withReq.graph.nodes[0]!.id;
    const linked = run(withReq, { type: 'link.create', linkType: 'implements', src: fn.id, dst: reqId }, ctx).project;
    const edited = run(
      linked,
      { type: 'pin.update', screenId: SCREEN.id, pinId: fn.id, title: '취소 요청 (변경)' },
      ctx,
    ).project;
    expect(edited.graph.links[0]!.suspectSince).toBe(AT);
    expect(traceability(edited).suspectLinks).toHaveLength(1);
    const acked = run(edited, { type: 'link.ack', linkId: edited.graph.links[0]!.id }, ctx).project;
    expect(acked.graph.links[0]!.suspectSince).toBeNull();
  });

  it('finds orphan pins and orphan requirements', () => {
    const { project, ctx } = seeded();
    const lonely = run(project, { type: 'node.create', nodeType: 'policy', title: '정책', body: '' }, ctx).project;
    const report = traceability(lonely);
    expect(report.orphanPins).toHaveLength(3);
    expect(report.orphanNodes).toEqual([lonely.graph.nodes[0]!.id]);
    expect(report.coverage).toBe(0);
  });
});

describe('maturity ladder', () => {
  it('L0 after a screen and a pin; L1 after a cited paragraph and a linked policy; L2 after QA and a frame', () => {
    const { project, ctx } = seeded();
    const l0 = evaluateMaturityLevel(project);
    expect(l0.level).toBe('L0');
    expect(l0.levels[0]!.checks.every((check) => check.done)).toBe(true);

    const doc = project.doc!;
    let next = run(project, { type: 'doc.block.create', docId: doc.id, blockType: 'paragraph', text: '취소는 배송 전까지만.' }, ctx).project;
    const blockId = next.doc!.blocks[0]!.id;
    next = run(next, { type: 'doc.pin.link', docId: doc.id, blockId, pinId: next.pins[0]!.id }, ctx).project;
    const policyNode = run(next, { type: 'node.create', nodeType: 'policy', title: '배송 전 취소', body: '' }, ctx).project;
    const policyId = policyNode.graph.nodes[0]!.id;
    const linked = run(
      policyNode,
      { type: 'link.create', linkType: 'governs', src: policyId, dst: next.screen!.id },
      ctx,
    ).project;
    const l1 = evaluateMaturityLevel(linked);
    expect(l1.level).toBe('L1');
    expect(l1.next?.level).toBe('L2');

    const qaNode = run(linked, { type: 'node.create', nodeType: 'qa', title: '취소 확인', body: '' }, ctx).project;
    const qaId = qaNode.graph.nodes[1]!.id;
    const verified = run(
      qaNode,
      { type: 'link.create', linkType: 'verifies', src: qaId, dst: qaNode.pins[0]!.id },
      ctx,
    ).project;
    expect(evaluateMaturityLevel(verified).level).toBe('L1');
    const framed = run(
      verified,
      { type: 'screen.update', screenId: SCREEN.id, figmaUrl: 'https://www.figma.com/file/abc/Frame' },
      ctx,
    ).project;
    expect(evaluateMaturityLevel(framed).level).toBe('L2');
    expect(evaluateMaturityLevel(framed).next).toBeNull();
  });

  it('counts a publication as the L2 evidence too', () => {
    const { project, ctx } = seeded();
    const doc = project.doc!;
    let next = run(project, { type: 'doc.block.create', docId: doc.id, blockType: 'paragraph', text: '문장' }, ctx).project;
    next = run(next, { type: 'doc.pin.link', docId: doc.id, blockId: next.doc!.blocks[0]!.id, pinId: next.pins[0]!.id }, ctx).project;
    const reqNode = run(next, { type: 'node.create', nodeType: 'req', title: '요구', body: '' }, ctx).project;
    const reqId = reqNode.graph.nodes[0]!.id;
    next = run(reqNode, { type: 'link.create', linkType: 'implements', src: reqNode.pins[0]!.id, dst: reqId }, ctx).project;
    const qaNode = run(next, { type: 'node.create', nodeType: 'qa', title: 'QA', body: '' }, ctx).project;
    const qaId = qaNode.graph.nodes[1]!.id;
    next = run(qaNode, { type: 'link.create', linkType: 'verifies', src: qaId, dst: qaNode.pins[0]!.id }, ctx).project;
    expect(evaluateMaturityLevel(next, { published: true }).level).toBe('L2');
    expect(evaluateMaturityLevel(next).level).toBe('L1');
  });
});

describe('the pin-derived proposal', () => {
  it('drafts policies, requirements and QA cases, and adoption creates them at once', () => {
    const { project, ctx } = seeded();
    const proposal = extractGraphProposal(project, { id: `GP_${'g'.repeat(12)}`, at: AT });
    expect(proposal.nodes.map((node) => node.type)).toEqual(
      expect.arrayContaining(['policy', 'req', 'qa']),
    );
    expect(proposal.links.length).toBeGreaterThan(0);

    const proposed = run(project, { type: 'graph.proposal.create' }, ctx).project;
    expect(proposed.graphProposal?.nodes.length).toBeGreaterThan(0);
    const adopted = applyGraphProposal(proposed, ctx);
    expect(adopted.project.graph.nodes.length).toBe(proposal.nodes.length);
    expect(adopted.project.graph.links.length).toBe(proposal.links.length);
    expect(adopted.project.graphProposal?.state).toBe('adopted');
  });

  it('proposes nothing the graph already carries', () => {
    const { project, ctx } = seeded();
    const proposed = run(project, { type: 'graph.proposal.create' }, ctx).project;
    const adopted = applyGraphProposal(proposed, ctx).project;
    const again = extractGraphProposal(adopted, { id: `GP_${'h'.repeat(12)}`, at: AT });
    expect(again.nodes).toHaveLength(0);
    expect(again.summary).toContain('없습니다');
  });
});
