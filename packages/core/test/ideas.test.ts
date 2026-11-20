import { describe, expect, it } from 'vitest';
import {
  buildGraphProposalFromDraft,
  ungroundedRequirements,
} from '../src/graph';
import { execute, type ExecutionResult, type ExecuteContext, type IdKind } from '../src/project';
import type { EditableNodeType, Project } from '@spec-studio/protocol';

/**
 * The inbox's rules at the pure core (E1 §4 F2·F3): capture classifies, the
 * state machines refuse shortcuts, the kind-level link registry (A1) lets an
 * idea or an evidence row be an endpoint, and citing evidence is what marks
 * it `cited`.
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

function newProject(): Project {
  return execute({ ...emptyProject(), id: 'PRJ_ideas0000001', name: '취소 개선' }, {
    type: 'screen.attach',
    screen: {
      id: 'S_ideas00000001',
      title: '주문 상세',
      code: 'SCR-110',
      ref: { kind: 'image', value: 'data:image/svg+xml;base64,PHN2Zy8+' },
      viewport: { width: 1200, height: 800 },
      createdAt: AT,
      updatedAt: AT,
    },
  }, context()).project;
}

function emptyProject(): Project {
  return {
    version: 1,
    id: 'PRJ_ideas0000001',
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
}

function run(project: Project, command: Parameters<typeof execute>[1], ctx = context()): ExecutionResult {
  return execute(project, command, ctx);
}

describe('idea.capture', () => {
  it('derives the title from the first line and classifies the tags', () => {
    let project = newProject();
    project = run(project, { type: 'idea.capture', text: '주문 취소 UX 개선\n본문 둘째 줄' }).project;
    expect(project.ideas[0]).toMatchObject({ title: '주문 취소 UX 개선', tags: ['텍스트'], state: 'captured' });

    project = run(project, {
      type: 'idea.capture',
      text: '링크 아이디어',
      url: 'https://example.com/x',
      image: '/lib/img.png',
    }).project;
    expect(project.ideas[1]?.tags).toEqual(['텍스트', '링크', '이미지']);

    project = run(project, { type: 'idea.capture', text: '본문에 https://example.com/y 링크' }).project;
    expect(project.ideas[2]?.tags).toEqual(['텍스트', '링크']);
  });

  it('re-derives title and tags on update, and keeps the state machine one-way', () => {
    let project = newProject();
    const captured = run(project, { type: 'idea.capture', text: '첫 줄\n본문' });
    const ideaId = captured.project.ideas[0]!.id;

    const edited = run(captured.project, {
      type: 'idea.update',
      ideaId,
      text: '바뀐 첫 줄 https://example.com/z',
    });
    expect(edited.project.ideas[0]).toMatchObject({ title: '바뀐 첫 줄 https://example.com/z', tags: ['텍스트', '링크'] });

    const promoted = run(edited.project, { type: 'idea.update', ideaId, state: 'promoted' });
    expect(promoted.project.ideas[0]?.state).toBe('promoted');

    expect(() => run(promoted.project, { type: 'idea.archive', ideaId })).toThrow(/바꿀 수 없습니다/);
    expect(() => run(promoted.project, { type: 'idea.update', ideaId: 'I_missing00000', state: 'archived' })).toThrow(
      /찾지 못했습니다/,
    );

    const archived = run(edited.project, { type: 'idea.archive', ideaId });
    // archived stays in the list — a state, not a deletion (§5.2)
    expect(archived.project.ideas[0]).toMatchObject({ state: 'archived' });
    expect(archived.events[0]?.type).toBe('idea.archived');
  });
});

describe('evidence.capture', () => {
  it('derives a title from the url when none is given, and dismiss is one-way', () => {
    let project = newProject();
    const withTitle = run(project, {
      type: 'evidence.capture',
      url: 'https://example.com/a/cancel',
      title: '경쟁사 A 정책',
      excerpt: '24시간 내 무료 취소',
      evidenceType: 'web',
    });
    expect(withTitle.project.evidence[0]?.title).toBe('경쟁사 A 정책');

    const derived = run(withTitle.project, {
      type: 'evidence.capture',
      url: 'https://example.com/b/policy',
      excerpt: '발췌만 있다',
      evidenceType: 'pdf',
    });
    expect(derived.project.evidence[1]?.title).toBe('example.com/b/policy');

    const evidenceId = derived.project.evidence[0]!.id;
    const dismissed = run(derived.project, { type: 'evidence.dismiss', evidenceId });
    expect(dismissed.project.evidence[0]?.state).toBe('dismissed');
    expect(() => run(dismissed.project, { type: 'evidence.dismiss', evidenceId })).toThrow(/이미 기각된/);
  });
});

describe('the kind-level link registry (A1)', () => {
  function board(): { project: Project; reqId: string; pinId: string; ideaId: string; evidenceId: string } {
    let project = newProject();
    project = run(project, {
      type: 'pin.create',
      screenId: project.screen!.id,
      pinType: 'function',
      title: '취소 요청',
      body: '',
      anchor: { x: 0.2, y: 0.3 },
    }).project;
    project = run(project, { type: 'node.create', nodeType: 'req', title: '취소 시점 표시', body: '' }).project;
    project = run(project, { type: 'idea.capture', text: '아이디어' }).project;
    project = run(project, {
      type: 'evidence.capture',
      url: 'https://example.com/a',
      excerpt: '발췌',
      evidenceType: 'web',
    }).project;
    return {
      project,
      reqId: project.graph.nodes[0]!.id,
      pinId: project.pins[0]!.id,
      ideaId: project.ideas[0]!.id,
      evidenceId: project.evidence[0]!.id,
    };
  }

  it('cites evidence from a req or a pin and marks the row cited in the same write', () => {
    const { project, reqId, evidenceId } = board();
    const linked = run(project, { type: 'link.create', linkType: 'references', src: reqId, dst: evidenceId });
    expect(linked.project.graph.links).toHaveLength(1);
    expect(linked.project.evidence[0]?.state).toBe('cited');
    expect(linked.events.map((event) => event.type)).toEqual(['link.created', 'evidence.updated']);
  });

  it('refuses evidence and idea as sources', () => {
    const { project, reqId, evidenceId, ideaId } = board();
    expect(() =>
      run(project, { type: 'link.create', linkType: 'references', src: evidenceId, dst: reqId }),
    ).toThrow(/연결할 수 없습니다/);
    expect(() =>
      run(project, { type: 'link.create', linkType: 'derived_from', src: ideaId, dst: reqId }),
    ).toThrow(/연결할 수 없습니다/);
    expect(() =>
      run(project, { type: 'link.create', linkType: 'references', src: evidenceId, dst: evidenceId }),
    ).toThrow(/같은 객체로는/);
  });

  it('derives a req from an idea, and only through derived_from', () => {
    const { project, reqId, ideaId } = board();
    const linked = run(project, { type: 'link.create', linkType: 'derived_from', src: reqId, dst: ideaId });
    expect(linked.project.graph.links[0]).toMatchObject({ type: 'derived_from', dst: ideaId });
    expect(() =>
      run(project, { type: 'link.create', linkType: 'references', src: reqId, dst: ideaId }),
    ).toThrow(/연결할 수 없습니다/);
  });

  it('lists requirement nodes with no evidence behind them', () => {
    const { project, reqId, evidenceId } = board();
    expect(ungroundedRequirements(project).map((node) => node.id)).toEqual([reqId]);
    const grounded = run(project, {
      type: 'link.create',
      linkType: 'references',
      src: reqId,
      dst: evidenceId,
    }).project;
    expect(ungroundedRequirements(grounded)).toEqual([]);
  });

  it('adopts a graph draft that names an idea, and drops an id the inbox lacks', () => {
    const { project, ideaId } = board();
    const draft = {
      summary: '요구사항에 아이디어 출처를 단다',
      nodes: [{ key: 'n1', type: 'req' as const, title: '취소 가능 시점 안내 문구', body: '', pins: [] }],
      links: [
        { type: 'derived_from' as const, src: 'item:n1', dst: `idea:${ideaId}` },
        { type: 'derived_from' as const, src: 'item:n1', dst: 'idea:I_unknown0000' },
      ],
    };
    const card = buildGraphProposalFromDraft(project, draft, {
      id: 'GP_adopt00000001',
      at: AT,
      source: 'rule',
      provider: null,
      model: null,
    });
    // the unknown idea never reaches the card
    expect(card.links).toEqual([{ type: 'derived_from', src: 'item:n1', dst: `idea:${ideaId}` }]);

    const drafted = run(project, {
      type: 'graph.proposal.create',
      draft: {
        summary: card.summary,
        nodes: [{ key: 'n1', type: 'req', title: '취소 가능 시점 안내 문구', body: '', pins: [] }],
        links: [{ type: 'derived_from', src: 'item:n1', dst: `idea:${ideaId}` }],
      },
    }).project;
    const decided = run(drafted, {
      type: 'graph.proposal.adopt',
      proposalId: drafted.graphProposal!.id,
    });
    const link = decided.project.graph.links[0]!;
    expect(link.type).toBe('derived_from');
    expect(link.dst).toBe(ideaId);
  });
});
