import {
  GRAPH_LINK_LABEL,
  NODE_TYPE_INITIAL_STATE,
  type Doc,
  type EditableNodeType,
  type Graph,
  type GraphLink,
  type GraphLinkType,
  type GraphNode,
  type GraphNodeType,
  type GraphProposal,
  type Pin,
  type Project,
  type Screen,
} from '@spec-studio/protocol';
import { staleBadges } from './doc';

/**
 * The graph is read, not stored twice. Screens and pins already exist as
 * objects, so this view joins them with the four editable kinds into one list
 * of six types. Every function here is pure: ids and timestamps arrive as
 * arguments, which is what lets the traceability rules be tested without a
 * database.
 */

export interface GraphViewNode {
  id: string;
  type: GraphNodeType;
  title: string;
  body: string;
  state: string;
  /** A pin keeps its screen and number; the graph shows both. */
  detail: string | null;
}

export interface TraceabilityReport {
  /** Pins that no link touches at all — the first thing a reviewer hunts for. */
  orphanPins: string[];
  /** Nodes of a kind that demands a link but has none (req, policy, qa, contract). */
  orphanNodes: string[];
  suspectLinks: GraphLink[];
  /** Pins with at least one incoming or outgoing link, over all pins. */
  connectedPins: number;
  pins: number;
  /** 0..1, rounded to three places so the badge is stable. */
  coverage: number;
  byType: Record<GraphLinkType, number>;
}

export interface MaturityCheck {
  id: string;
  label: string;
  done: boolean;
  hint: string;
}

export interface MaturityLevelReport {
  level: 'L0' | 'L1' | 'L2';
  checks: MaturityCheck[];
}

export interface Maturity {
  level: 'L0' | 'L1' | 'L2';
  levels: MaturityLevelReport[];
  /** The next rung and what it still wants; `null` at L2. */
  next: { level: 'L1' | 'L2'; todo: MaturityCheck[] } | null;
  /** Flat list of every unmet check, for the header tooltip. */
  todo: MaturityCheck[];
}

export function nodeViewOf(node: GraphNode): GraphViewNode {
  return {
    id: node.id,
    type: node.type,
    title: node.title,
    body: node.body,
    state: node.state,
    detail: null,
  };
}

export function pinViewOf(pin: Pin, screen: Screen | null): GraphViewNode {
  const code = screen?.code ?? 'SCR';
  return {
    id: pin.id,
    type: 'pin',
    title: pin.title,
    body: pin.body,
    state: pin.type,
    detail: `${code}-${pin.number}`,
  };
}

export function screenViewOf(screen: Screen): GraphViewNode {
  return {
    id: screen.id,
    type: 'screen',
    title: screen.title,
    body: '',
    state: screen.code,
    detail: screen.code,
  };
}

/** The six types in one list, screens first, then their pins. */
export function graphViewNodes(project: Project): GraphViewNode[] {
  const nodes: GraphViewNode[] = [];
  if (project.screen !== null) nodes.push(screenViewOf(project.screen));
  for (const pin of project.pins) nodes.push(pinViewOf(pin, project.screen));
  for (const node of project.graph.nodes) nodes.push(nodeViewOf(node));
  return nodes;
}

export function graphTypeOfId(project: Project, id: string): GraphNodeType | null {
  if (project.screen !== null && project.screen.id === id) return 'screen';
  if (project.pins.some((pin) => pin.id === id)) return 'pin';
  const node = project.graph.nodes.find((candidate) => candidate.id === id);
  return node === undefined ? null : node.type;
}

export function graphTitleOfId(project: Project, id: string): string {
  if (project.screen !== null && project.screen.id === id) return project.screen.title;
  const pin = project.pins.find((candidate) => candidate.id === id);
  if (pin !== undefined) return `${project.screen?.code ?? 'SCR'}-${pin.number} ${pin.title}`;
  return project.graph.nodes.find((candidate) => candidate.id === id)?.title ?? id;
}

/** Drops links whose ends no longer exist, so a reload never draws a ghost edge. */
export function normalizeGraph(project: Project): Graph {
  const known = new Set<string>();
  if (project.screen !== null) known.add(project.screen.id);
  for (const pin of project.pins) known.add(pin.id);
  for (const node of project.graph.nodes) known.add(node.id);
  const links = project.graph.links.filter(
    (link) => known.has(link.src) && known.has(link.dst) && link.src !== link.dst,
  );
  if (links.length === project.graph.links.length) return project.graph;
  return { nodes: project.graph.nodes, links };
}

export function traceability(project: Project): TraceabilityReport {
  const links = project.graph.links;
  const touched = new Set<string>();
  const byType = Object.fromEntries(
    Object.keys(GRAPH_LINK_LABEL).map((key) => [key, 0]),
  ) as Record<GraphLinkType, number>;
  for (const link of links) {
    touched.add(link.src);
    touched.add(link.dst);
    byType[link.type] += 1;
  }

  const orphanPins = project.pins.filter((pin) => !touched.has(pin.id)).map((pin) => pin.id);

  // A requirement wants an implementation (or an edge handler), a policy a
  // screen or pin it governs, a QA case something it verifies, a contract a
  // screen it stands for. Anything else is a node whose reason is not written
  // down yet.
  const inbound: Record<GraphLinkType, Set<string>> = Object.fromEntries(
    Object.keys(GRAPH_LINK_LABEL).map((key) => [key, new Set<string>()]),
  ) as Record<GraphLinkType, Set<string>>;
  const outbound: Record<GraphLinkType, Set<string>> = Object.fromEntries(
    Object.keys(GRAPH_LINK_LABEL).map((key) => [key, new Set<string>()]),
  ) as Record<GraphLinkType, Set<string>>;
  for (const link of links) {
    inbound[link.type].add(link.dst);
    outbound[link.type].add(link.src);
  }

  const orphanNodes = project.graph.nodes
    .filter((node) => {
      switch (node.type) {
        case 'req':
          return !inbound.implements.has(node.id) && !inbound.handles_edge.has(node.id);
        case 'policy':
          // A policy governs something (outgoing) or was derived from something.
          return (
            !outbound.governs.has(node.id) &&
            !outbound.derived_from.has(node.id) &&
            !inbound.derived_from.has(node.id)
          );
        case 'qa':
          // A QA case that verifies nothing proves nothing.
          return !outbound.verifies.has(node.id);
        case 'contract':
          return !touched.has(node.id);
        default:
          return false;
      }
    })
    .map((node) => node.id);

  const pins = project.pins.length;
  return {
    orphanPins,
    orphanNodes,
    suspectLinks: links.filter((link) => link.suspectSince !== null),
    connectedPins: pins - orphanPins.length,
    pins,
    coverage: pins === 0 ? 0 : Math.round(((pins - orphanPins.length) / pins) * 1000) / 1000,
    byType,
  };
}

/**
 * The L0 → L1 → L2 ladder. Each rung names the check that earns it, so the
 * header can show a badge and the sentence that would move it up instead of a
 * score nobody can act on.
 *
 *   L0 초안      화면 + 핀
 *   L1 구조화    문서 문단이 핀을 인용 · stale 0 · 정책/요구사항이 하나 이상 연결
 *   L2 발행 준비 QA 케이스가 연결 · Figma 프레임(또는 발행 기록)이 있음
 */
export function evaluateMaturityLevel(
  project: Project,
  options: { published?: boolean; doc?: Doc | null } = {},
): Maturity {
  const doc = options.doc === undefined ? project.doc : options.doc;
  const stale = doc === null ? 0 : staleBadges(doc, project.pins).length;
  const citedBlocks = doc === null ? 0 : doc.blocks.filter((block) => block.pinRefs.length > 0).length;

  const report = traceability(project);
  const structural = project.graph.nodes.filter((node) => node.type === 'req' || node.type === 'policy');
  const structuralLinked = structural.filter((node) => !report.orphanNodes.includes(node.id));
  const qaLinked = project.graph.nodes
    .filter((node) => node.type === 'qa')
    .some((node) => !report.orphanNodes.includes(node.id));
  const hasFrame =
    project.screen !== null &&
    ((project.screen.figmaUrl ?? null) !== null || project.screen.ref.kind === 'figma_frame');
  const hasEvidence = hasFrame || options.published === true;

  const l0: MaturityCheck[] = [
    {
      id: 'screen',
      label: '화면이 등록되어 있다',
      done: project.screen !== null,
      hint: '이미지·Figma 프레임·라우트 중 하나로 화면을 엽니다.',
    },
    {
      id: 'pin',
      label: '핀이 1개 이상 찍혀 있다',
      done: project.pins.length > 0,
      hint: '화면을 클릭해 번호 핀을 찍습니다.',
    },
  ];
  const l1: MaturityCheck[] = [
    {
      id: 'doc-cites-pin',
      label: '문단이 핀을 인용한다',
      done: citedBlocks > 0,
      hint: '문서에 문단을 쓰고 핀을 연결합니다.',
    },
    {
      id: 'no-stale',
      label: 'stale 인용이 0건이다',
      done: stale === 0 && project.pins.length > 0,
      hint: stale === 0 ? '핀을 고치면 문단의 확인 배지를 먼저 해제합니다.' : `확인할 인용 ${stale}건이 남았습니다.`,
    },
    {
      id: 'structured-node',
      label: '요구사항이나 정책이 그래프에 연결되어 있다',
      done: structuralLinked.length > 0,
      hint: '핀에서 추출하거나 그래프 탭에서 요구사항·정책을 추가하고 연결합니다.',
    },
  ];
  const l2: MaturityCheck[] = [
    {
      id: 'qa-linked',
      label: 'QA 케이스가 연결되어 있다',
      done: qaLinked,
      hint: '핀에서 QA 초안을 추출하고 검증 대상을 연결합니다.',
    },
    {
      id: 'evidence',
      label: 'Figma 프레임이나 발행 검증 조건이 있다',
      done: hasEvidence,
      hint: 'Figma 프레임을 등록하거나 Confluence로 한 번 발행합니다.',
    },
  ];

  const all = (checks: MaturityCheck[]) => checks.every((check) => check.done);
  const level: Maturity['level'] = !all(l0) ? 'L0' : !all(l1) ? 'L0' : all(l2) ? 'L2' : 'L1';
  const levels: MaturityLevelReport[] = [
    { level: 'L0', checks: l0 },
    { level: 'L1', checks: l1 },
    { level: 'L2', checks: l2 },
  ];

  const nextTarget: 'L1' | 'L2' | null = level === 'L2' ? null : level === 'L1' ? 'L2' : 'L1';
  const nextChecks = nextTarget === null ? [] : nextTarget === 'L1' ? l1 : l2;
  const next =
    nextTarget === null
      ? null
      : { level: nextTarget, todo: nextChecks.filter((check) => !check.done) };

  // L0 that has not been earned still reads L0, but the todo list is its first rung.
  const currentChecks = level === 'L0' && !all(l0) ? l0 : nextChecks;
  return {
    level,
    levels,
    next: level === 'L0' && !all(l0) ? { level: 'L1', todo: l0.filter((c) => !c.done) } : next,
    todo: currentChecks.filter((check) => !check.done),
  };
}

// ── building the proposal from pins ───────────────────────────────────────

export interface ProposalDraftOptions {
  id: string;
  at: string;
}

interface DraftNode {
  key: string;
  type: EditableNodeType;
  title: string;
  body: string;
  pinId: string | null;
}

/**
 * Reads the pins already on the screen and drafts what a spec still owes them:
 * a policy for a policy pin, a requirement for a behaviour, a QA case that
 * would prove it. Only what is missing is proposed — running it twice in a row
 * produces nothing the second time instead of duplicates.
 */
export function extractGraphProposal(project: Project, options: ProposalDraftOptions): GraphProposal {
  if (project.screen === null) {
    return emptyProposal(options, '화면이 없어 핀에서 초안을 읽을 수 없습니다.');
  }
  if (project.pins.length === 0) {
    return emptyProposal(options, '핀이 없어 추출할 초안이 없습니다.');
  }

  const existingTitles = new Set(
    project.graph.nodes.map((node) => `${node.type}:${normalizeText(node.title)}`),
  );
  const existingLinks = new Set(
    project.graph.links.map((link) => `${link.type}:${link.src}:${link.dst}`),
  );
  const touched = new Set(project.graph.links.flatMap((link) => [link.src, link.dst]));

  const nodes: DraftNode[] = [];
  const links: GraphProposal['links'] = [];
  let keySeq = 0;
  const nextKey = (type: EditableNodeType) => `n${++keySeq}-${type}`;

  const addNode = (
    type: EditableNodeType,
    title: string,
    body: string,
    pinId: string | null,
  ): string | null => {
    const clean = title.trim();
    if (clean === '') return null;
    const signature = `${type}:${normalizeText(clean)}`;
    if (existingTitles.has(signature)) return null;
    existingTitles.add(signature);
    const key = nextKey(type);
    nodes.push({ key, type, title: clean, body: body.trim(), pinId });
    return `item:${key}`;
  };

  const addLink = (type: GraphLinkType, src: string, dst: string) => {
    const key = `${type}:${src}:${dst}`;
    if (src === dst || existingLinks.has(key)) return;
    existingLinks.add(key);
    links.push({ type, src, dst });
  };

  for (const pin of [...project.pins].sort((a, b) => a.number - b.number)) {
    const pinRef = `pin:${pin.id}`;
    const label = `#${pin.number} ${pin.title}`;
    switch (pin.type) {
      case 'policy': {
        const item = addNode('policy', pin.title, policySentence(pin), pin.id);
        if (item !== null) addLink('governs', item, pinRef);
        break;
      }
      case 'exception': {
        const req = addNode('req', `예외: ${pin.title}`, exceptionSentence(pin), pin.id);
        if (req !== null) addLink('handles_edge', pinRef, req);
        const qa = addNode('qa', `${label} 예외 확인`, qaSentence(pin, '예외 상황에서 안내와 복구 경로가 보인다'), pin.id);
        if (qa !== null) {
          addLink('verifies', qa, pinRef);
          if (req !== null) addLink('verifies', qa, req);
        }
        break;
      }
      case 'state': {
        const qa = addNode('qa', `${label} 상태 확인`, qaSentence(pin, `${pin.title} 상태에서 화면이 깨지지 않는다`), pin.id);
        if (qa !== null) addLink('verifies', qa, pinRef);
        break;
      }
      case 'data': {
        const contract = addNode('contract', pin.title, pin.body || `${pin.title} 데이터의 모양과 출처를 정의한다.`, pin.id);
        if (contract !== null) addLink('derived_from', contract, pinRef);
        break;
      }
      case 'permission': {
        const policy = addNode('policy', pin.title, pin.body || `${pin.title} 권한이 없는 사용자는 이 동작을 볼 수 없다.`, pin.id);
        if (policy !== null) addLink('governs', policy, pinRef);
        break;
      }
      case 'function':
      default: {
        const req = addNode('req', pin.title, pin.body || `${pin.title} 동작이 제공된다.`, pin.id);
        if (req !== null) addLink('implements', pinRef, req);
        const qa = addNode('qa', `${label} 동작 확인`, qaSentence(pin, `${pin.title} 동작이 정상 흐름에서 동작한다`), pin.id);
        if (qa !== null) {
          addLink('verifies', qa, pinRef);
          if (req !== null) addLink('verifies', qa, req);
        }
        break;
      }
    }
  }

  // A pin with no link yet is worth a reference even when nothing else can be
  // inferred: it keeps the pin out of the orphan list without inventing meaning.
  for (const pin of project.pins) {
    if (!touched.has(pin.id) && !links.some((link) => link.src === `pin:${pin.id}` || link.dst === `pin:${pin.id}`)) {
      const req = addNode('req', pin.title, pin.body || `${pin.title} 요구사항을 정리한다.`, pin.id);
      if (req !== null) addLink('references', `pin:${pin.id}`, req);
    }
  }

  if (nodes.length === 0) {
    return emptyProposal(options, '핀에서 새로 추출할 초안이 없습니다. 이미 그래프에 반영되어 있습니다.');
  }

  const counts = countByType(nodes);
  const summary = `핀 ${project.pins.length}개에서 ${describeCounts(counts)} 초안과 링크 ${links.length}개를 추출했습니다.`;
  return {
    id: options.id,
    summary,
    state: 'open',
    nodes: nodes.map((node) => ({
      key: node.key,
      type: node.type,
      title: node.title,
      body: node.body,
      pinId: node.pinId,
    })),
    links,
    createdAt: options.at,
    decidedAt: null,
  };
}

function emptyProposal(options: ProposalDraftOptions, summary: string): GraphProposal {
  return {
    id: options.id,
    summary,
    state: 'open',
    nodes: [],
    links: [],
    createdAt: options.at,
    decidedAt: null,
  };
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function policySentence(pin: Pin): string {
  const body = pin.body.trim();
  return body === '' ? `${pin.title} 조건이 성립할 때만 이 동작이 허용된다.` : body;
}

function exceptionSentence(pin: Pin): string {
  const body = pin.body.trim();
  return body === '' ? `${pin.title} 상황에서 사용자는 이유와 다음 행동을 볼 수 있어야 한다.` : body;
}

export function qaSentence(pin: Pin, expectation: string): string {
  const precondition = pin.body.trim() === '' ? pin.title : pin.body.trim();
  return [`사전조건: ${precondition}`, `기대 결과: ${expectation}.`, '판정: 통과 / 실패 / 차단'].join('\n');
}

function countByType(nodes: readonly DraftNode[]): Record<EditableNodeType, number> {
  const counts: Record<EditableNodeType, number> = { req: 0, policy: 0, contract: 0, qa: 0 };
  for (const node of nodes) counts[node.type] += 1;
  return counts;
}

function describeCounts(counts: Record<EditableNodeType, number>): string {
  const parts: string[] = [];
  if (counts.policy > 0) parts.push(`정책 ${counts.policy}`);
  if (counts.req > 0) parts.push(`요구사항 ${counts.req}`);
  if (counts.qa > 0) parts.push(`QA ${counts.qa}`);
  if (counts.contract > 0) parts.push(`계약 ${counts.contract}`);
  return parts.join(' · ');
}

/** Keys of a proposal, resolved to real ids only when it is adopted. */
export function resolveProposalRef(
  ref: string,
  created: ReadonlyMap<string, string>,
): string | null {
  const at = ref.indexOf(':');
  if (at < 0) return null;
  const scheme = ref.slice(0, at);
  const value = ref.slice(at + 1);
  if (scheme === 'item') return created.get(value) ?? null;
  if (scheme === 'pin' || scheme === 'node') return value;
  return null;
}

export function makeGraphNode(input: {
  id: string;
  type: EditableNodeType;
  title: string;
  body: string;
  at: string;
  state?: string;
}): GraphNode {
  return {
    id: input.id,
    type: input.type,
    title: input.title.trim(),
    body: input.body.trim(),
    state: input.state ?? NODE_TYPE_INITIAL_STATE[input.type],
    createdAt: input.at,
    updatedAt: input.at,
  };
}

/** A link whose endpoint moved on keeps its identity and gains a question. */
export function markLinksSuspect(
  links: readonly GraphLink[],
  nodeId: string,
  why: string,
  at: string,
): GraphLink[] {
  return links.map((link) =>
    link.src === nodeId || link.dst === nodeId
      ? { ...link, suspectSince: at, suspectWhy: why }
      : link,
  );
}

export function nodeStateOptions(type: EditableNodeType): readonly string[] {
  switch (type) {
    case 'req':
      return ['draft', 'approved', 'building', 'verified'];
    case 'policy':
      return ['draft', 'agreed', 'applied', 'superseded'];
    case 'contract':
      return ['draft', 'agreed', 'applied'];
    case 'qa':
      return ['pass', 'fail', 'blocked'];
  }
}

export function describeLink(project: Project, link: GraphLink): string {
  return `${graphTitleOfId(project, link.src)} ${GRAPH_LINK_LABEL[link.type]} ${graphTitleOfId(project, link.dst)}`;
}
