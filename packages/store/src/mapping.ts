import { createHash, randomBytes } from 'node:crypto';
import {
  NODE_TYPE_KIND,
  type Block,
  type BlockPinRef,
  type Doc,
  type EditableNodeType,
  type GraphLink,
  type GraphNode,
  type GraphProposal,
  type Pin,
  type Project,
  type Proposal,
  type ProposalPatch,
  type Screen,
  type ScreenRef,
} from '@spec-studio/protocol';

/**
 * Row ↔ object mapping. The schema stores one shape (`obj` with a JSON
 * `props`) and the domain uses another (typed screens and pins), so the
 * translation lives here, in one file, with the column names in one place.
 */

export interface ObjRow {
  id: string;
  project_id: string | null;
  kind: string;
  subtype: string | null;
  title: string;
  parent_id: string | null;
  props: string;
  state: string;
  rev: number;
  hash: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScreenProps {
  code: string;
  ref: ScreenRef;
  /** Registered Figma frame, or null. Reference data, never fetched. */
  figmaUrl?: string | null;
  viewport: { width: number; height: number } | null;
  pinSeq: number;
}

export interface PinProps {
  number: number;
  body: string;
  anchor: { x: number; y: number };
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

/** Short, stable content hash: the schema only needs it to be non-empty and to change with content. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newSuffix(length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += ALPHABET.charAt(byte % ALPHABET.length);
  return out;
}

export const newProjectId = (): string => `PRJ_${newSuffix()}`;
export const newScreenId = (): string => `S_${newSuffix()}`;
export const newPinId = (): string => `P_${newSuffix()}`;
export const newDocId = (): string => `D_${newSuffix()}`;
export const newBlockId = (): string => `B_${newSuffix()}`;
export const newProposalId = (): string => `PR_${newSuffix()}`;
export const newLinkId = (): string => `L_${newSuffix()}`;
export const newGraphProposalId = (): string => `GP_${newSuffix()}`;

/** A graph node's id prefix is its `obj` kind: N_ req/policy, C_ contract, V_ qa. */
export function newNodeId(type: EditableNodeType): string {
  const { kind } = NODE_TYPE_KIND[type];
  switch (kind) {
    case 'specnode':
      return `N_${newSuffix()}`;
    case 'contract':
      return `C_${newSuffix()}`;
    case 'verification':
      return `V_${newSuffix()}`;
    default:
      throw new Error(`a graph node cannot be a ${kind}`);
  }
}
export const newOpId = (): string => `op_${newSuffix()}`;

export function screenToRow(screen: Screen, projectId: string): ObjRow {
  const props: ScreenProps = {
    code: screen.code,
    ref: screen.ref,
    figmaUrl: screen.figmaUrl ?? null,
    viewport: screen.viewport,
    pinSeq: 0,
  };
  return {
    id: screen.id,
    project_id: projectId,
    kind: 'screen',
    subtype: null,
    title: screen.title,
    parent_id: null,
    props: JSON.stringify(props),
    state: 'linked',
    rev: 1,
    hash: contentHash({
      title: screen.title,
      code: screen.code,
      ref: screen.ref,
      figmaUrl: screen.figmaUrl ?? null,
    }),
    deleted_at: null,
    created_at: screen.createdAt,
    updated_at: screen.updatedAt,
  };
}

export function screenFromRow(row: ObjRow): Screen {
  const props = parseJson<ScreenProps>(row.props);
  return {
    id: row.id,
    title: row.title,
    code: props.code,
    ref: props.ref,
    figmaUrl: props.figmaUrl ?? null,
    viewport: props.viewport ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function screenPinSeq(row: ObjRow): number {
  return parseJson<ScreenProps>(row.props).pinSeq ?? 0;
}

export function pinToRow(pin: Pin, projectId: string): ObjRow {
  const props: PinProps = { number: pin.number, body: pin.body, anchor: pin.anchor };
  return {
    id: pin.id,
    project_id: projectId,
    kind: 'pin',
    subtype: pin.type,
    title: pin.title,
    parent_id: pin.screenId,
    props: JSON.stringify(props),
    state: 'open',
    rev: 1,
    hash: contentHash({ title: pin.title, type: pin.type, body: pin.body, number: pin.number }),
    deleted_at: null,
    created_at: pin.createdAt,
    updated_at: pin.updatedAt,
  };
}

export function pinFromRow(row: ObjRow): Pin {
  const props = parseJson<PinProps>(row.props);
  return {
    id: row.id,
    screenId: row.parent_id ?? '',
    number: props.number,
    type: row.subtype as Pin['type'],
    title: row.title,
    body: props.body,
    anchor: props.anchor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function graphNodeToRow(node: GraphNode, projectId: string): ObjRow {
  const { kind, subtype } = NODE_TYPE_KIND[node.type];
  return {
    id: node.id,
    project_id: projectId,
    kind,
    subtype,
    title: node.title,
    parent_id: null,
    props: JSON.stringify({ body: node.body }),
    state: node.state,
    rev: 1,
    hash: contentHash({ title: node.title, body: node.body, state: node.state, type: node.type }),
    deleted_at: null,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
  };
}

export function graphNodeFromRow(row: ObjRow): GraphNode | null {
  const type =
    row.kind === 'specnode' && row.subtype === 'requirement'
      ? ('req' as const)
      : row.kind === 'specnode' && row.subtype === 'policy'
        ? ('policy' as const)
        : row.kind === 'contract'
          ? ('contract' as const)
          : row.kind === 'verification'
            ? ('qa' as const)
            : null;
  if (type === null) return null;
  const props = parseJson<{ body?: string }>(row.props || '{}');
  return {
    id: row.id,
    type,
    title: row.title,
    body: props.body ?? '',
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface LinkRow {
  id: string;
  type: string;
  src: string;
  dst: string;
  suspect_since: string | null;
  suspect_why: string | null;
  created_at: string;
}

export function linkFromRow(row: LinkRow): GraphLink {
  return {
    id: row.id,
    type: row.type as GraphLink['type'],
    src: row.src,
    dst: row.dst,
    suspectSince: row.suspect_since,
    suspectWhy: row.suspect_why,
    createdAt: row.created_at,
  };
}

export function projectFromRows(input: {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  screen: ObjRow | null;
  pins: ObjRow[];
  doc?: Doc | null;
  proposal?: Proposal | null;
  graphNodes?: ObjRow[];
  links?: LinkRow[];
  graphProposal?: GraphProposalRow | null;
}): Project {
  const screen = input.screen === null ? null : screenFromRow(input.screen);
  const pins = input.pins.map(pinFromRow).sort((a, b) => a.number - b.number);
  return {
    version: 1,
    id: input.id,
    name: input.name,
    screen,
    pins,
    pinSeq: input.screen === null ? 0 : screenPinSeq(input.screen),
    doc: input.doc ?? null,
    proposal: input.proposal ?? null,
    graph: {
      nodes: (input.graphNodes ?? [])
        .map(graphNodeFromRow)
        .filter((node): node is GraphNode => node !== null),
      links: (input.links ?? []).map(linkFromRow),
    },
    graphProposal:
      input.graphProposal === undefined || input.graphProposal === null
        ? null
        : graphProposalFromRow(input.graphProposal),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

// ── graph proposal rows ───────────────────────────────────────────────

export interface GraphProposalRow {
  id: string;
  project_id: string;
  state: string;
  created_at: string;
  decided_at: string | null;
  payload: string;
}

export function graphProposalFromRow(row: GraphProposalRow): GraphProposal {
  const parsed = JSON.parse(row.payload) as GraphProposal;
  return {
    ...parsed,
    id: row.id,
    state: row.state as GraphProposal['state'],
    // Rows written before the AI layer carry no provenance; they were rules.
    source: parsed.source ?? 'rule',
    provider: parsed.provider ?? null,
    model: parsed.model ?? null,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

// ── document rows ──────────────────────────────────────────────────────

export interface DocRow {
  id: string;
  project_id: string | null;
  screen_id: string | null;
  title: string;
  rev: number;
  created_at: string;
  updated_at: string | null;
}

export interface BlockRow {
  id: string;
  doc_id: string;
  parent_id: string | null;
  idx: string;
  type: string;
  text: string;
  attrs: string;
  hash: string;
  state: 'live' | 'deleted';
  commit_seq: number | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * Position in the document, as text SQLite can order: six digits leave room for
 * 999,999 paragraphs and let a renumber rewrite the whole document in one pass.
 */
export function blockIdx(index: number): string {
  return String(Math.max(0, Math.trunc(index))).padStart(6, '0');
}

export function blockHash(block: Pick<Block, 'type' | 'text' | 'pinRefs'>): string {
  return contentHash({
    type: block.type,
    text: block.text,
    pins: block.pinRefs.map((ref) => [ref.pinId, ref.fingerprint]),
  });
}

interface BlockAttrs {
  pinRefs?: BlockPinRef[];
}

export function blockToRow(block: Block, docId: string, index: number): BlockRow {
  const attrs: BlockAttrs = { pinRefs: block.pinRefs };
  return {
    id: block.id,
    doc_id: docId,
    parent_id: null,
    idx: blockIdx(index),
    type: block.type,
    text: block.text,
    attrs: JSON.stringify(attrs),
    hash: blockHash(block),
    state: 'live',
    commit_seq: null,
    created_at: block.createdAt,
    updated_at: block.updatedAt,
  };
}

export function blockFromRow(row: BlockRow): Block {
  const attrs = parseJson<BlockAttrs>(row.attrs || '{}');
  const at = row.created_at ?? row.updated_at ?? '';
  return {
    id: row.id,
    type: row.type as Block['type'],
    text: row.text,
    pinRefs: attrs.pinRefs ?? [],
    createdAt: at,
    updatedAt: row.updated_at ?? at,
  };
}

export function docFromRows(row: DocRow, blocks: BlockRow[]): Doc {
  return {
    id: row.id,
    title: row.title,
    rev: Number(row.rev ?? 0),
    blocks: [...blocks]
      .sort((a, b) => (a.idx === b.idx ? a.id.localeCompare(b.id) : a.idx.localeCompare(b.idx)))
      .map(blockFromRow),
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

// ── proposal rows ──────────────────────────────────────────────────────

export interface ProposalRow {
  id: string;
  doc_id: string;
  origin: string;
  summary: string;
  base_rev: number;
  state: string;
  created_at: string;
  decided_at: string | null;
}

export interface ProposalOpRow {
  id: string;
  proposal_id: string;
  seq: number;
  kind: string;
  view: string;
  state: string;
}

interface ProposalOpView {
  blockId: string;
  afterBlockId: string | null;
  before: ProposalPatch['before'];
  after: ProposalPatch['after'];
}

export function proposalToRow(proposal: Proposal): ProposalRow {
  return {
    id: proposal.id,
    doc_id: proposal.docId,
    origin: proposal.origin,
    summary: proposal.summary,
    base_rev: proposal.baseRev,
    state: proposal.state,
    created_at: proposal.createdAt,
    decided_at: proposal.decidedAt,
  };
}

export function proposalOpToRow(
  proposal: Proposal,
  patch: ProposalPatch,
  seq: number,
  opId: string,
): ProposalOpRow {
  const view: ProposalOpView = {
    blockId: patch.blockId,
    afterBlockId: patch.afterBlockId,
    before: patch.before,
    after: patch.after,
  };
  return {
    id: opId,
    proposal_id: proposal.id,
    seq,
    kind: patch.before === null ? 'insert' : 'replace',
    view: JSON.stringify(view),
    state: proposal.state === 'open' ? 'open' : proposal.state === 'rejected' ? 'rejected' : 'adopted',
  };
}

export function proposalFromRows(row: ProposalRow, ops: ProposalOpRow[]): Proposal {
  const patches: ProposalPatch[] = [...ops]
    .sort((a, b) => a.seq - b.seq)
    .map((op) => {
      const view = parseJson<ProposalOpView>(op.view);
      return {
        blockId: view.blockId,
        afterBlockId: view.afterBlockId ?? null,
        before: view.before ?? null,
        after: view.after,
      };
    });
  return {
    id: row.id,
    docId: row.doc_id,
    summary: row.summary,
    origin: row.origin as Proposal['origin'],
    baseRev: Number(row.base_rev ?? 0),
    state: row.state as Proposal['state'],
    patches,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}
