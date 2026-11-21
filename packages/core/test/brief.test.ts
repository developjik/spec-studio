import { describe, expect, it } from 'vitest';
import { execute, type ExecutionResult, type ExecuteContext, type IdKind } from '../src/project';
import type { AiBriefDraft, EditableNodeType, Project } from '@spec-studio/protocol';

/**
 * A brief's road to a research document (F3-2): the trust boundary first —
 * an id the board does not have is rejected before any card exists — then
 * the same adoption a person already decides on, with every claim's source
 * spelled out or honestly marked.
 */

const AT = '2026-11-20T09:00:00.000Z';

function context(): ExecuteContext {
  let n = 0;
  const suffix = () => String(++n).padStart(12, '0');
  return {
    at: AT,
    nextId: (kind: IdKind, nodeType?: EditableNodeType) => {
      switch (kind) {
        case 'project':
          return `PRJ_${suffix()}`;
        case 'screen':
          return `S_${suffix()}`;
        case 'pin':
          return `P_${suffix()}`;
        case 'doc':
          return `D_${suffix()}`;
        case 'block':
          return `B_${suffix()}`;
        case 'proposal':
          return `PR_${suffix()}`;
        case 'node':
          return `${nodeType === 'contract' ? 'C' : nodeType === 'qa' ? 'V' : 'N'}_${suffix()}`;
        case 'link':
          return `L_${suffix()}`;
        case 'graphProposal':
          return `GP_${suffix()}`;
        case 'idea':
          return `I_${suffix()}`;
        case 'evidence':
          return `E_${suffix()}`;
      }
    },
  };
}

function seededResearch(): { project: Project; docId: string; evidenceId: string; evidenceTitle: string } {
  const ctx = context();
  let project: Project = {
    version: 1,
    id: 'PRJ_brief0000001',
    name: '취소 개선',
    screen: null,
    pins: [],
    pinSeq: 0,
    docs: [],
    proposals: [],
    ideas: [],
    evidence: [],
    graph: { nodes: [], links: [] },
    graphProposal: null,
    createdAt: AT,
    updatedAt: AT,
  };
  project = execute(project, { type: 'doc.create', title: '취소 리서치', kind: 'research' }, ctx).project;
  project = execute(project, { type: 'idea.capture', text: '주문 취소 UX 개선' }, ctx).project;
  project = execute(
    project,
    {
      type: 'evidence.capture',
      url: 'https://example.com/a/cancel',
      title: '경쟁사 A 취소 정책',
      excerpt: '결제 후 24시간 이내에는 무료 취소가 가능하다.',
      evidenceType: 'web',
    },
    ctx,
  ).project;
  return {
    project,
    docId: project.docs[0]!.id,
    evidenceId: project.evidence[0]!.id,
    evidenceTitle: project.evidence[0]!.title,
  };
}

const briefOf = (evidenceId: string): AiBriefDraft =>
  ({
    title: '취소 정책 브리프',
    summary: '경쟁사 정책을 근거로 취소 가능 시점을 정리한다.',
    claims: [
      { text: '결제 후 24시간 내 무료 취소가 가능하다', evidenceRefs: [evidenceId], ungrounded: false },
      { text: '취소 수수료는 0원이 유지될 것이라 가정한다', evidenceRefs: [], ungrounded: true },
    ],
  }) as AiBriefDraft;

function run(project: Project, command: Parameters<typeof execute>[1]): ExecutionResult {
  return execute(project, command, context());
}

describe('a brief draft through the decision card', () => {
  it('refuses a claim citing evidence the board does not have', () => {
    const { project, docId } = seededResearch();
    const brief = briefOf('E_missing00000');
    expect(() =>
      run(project, { type: 'proposal.create', docId, draft: brief, source: 'llm' }),
    ).toThrow(/없는 근거를 인용했습니다: E_missing00000/);
  });

  it('adopts into a research doc as heading, summary and marked claim paragraphs', () => {
    const { project, docId, evidenceId, evidenceTitle } = seededResearch();
    const created = run(project, {
      type: 'proposal.create',
      docId,
      draft: briefOf(evidenceId),
      source: 'llm',
    });
    const proposal = created.project.proposals[0]!;
    expect(proposal.state).toBe('open');
    expect(proposal.patches.every((patch) => patch.before === null)).toBe(true);

    const adopted = run(created.project, {
      type: 'proposal.adopt',
      docId,
      proposalId: proposal.id,
    });
    const doc = adopted.project.docs[0]!;
    expect(doc.blocks.map((block) => block.type)).toEqual(['heading', 'paragraph', 'paragraph', 'paragraph']);
    expect(doc.blocks[0]?.text).toBe('취소 정책 브리프');
    expect(doc.blocks[1]?.text).toBe('경쟁사 정책을 근거로 취소 가능 시점을 정리한다.');
    expect(doc.blocks[2]?.text).toBe(
      `결제 후 24시간 내 무료 취소가 가능하다 (출처: ${evidenceTitle})`,
    );
    expect(doc.blocks[3]?.text).toBe('취소 수수료는 0원이 유지될 것이라 가정한다 (근거 없음)');
  });
});
