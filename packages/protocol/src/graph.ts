import { z } from 'zod';
import { ObjectIdSchema, PinIdSchema, type ObjectKind } from './ids.js';

/**
 * The v1 object graph. Six node types are what a screen spec is made of, and
 * seven named links are the only way they may be joined — an untyped edge would
 * say "these are related" without saying how, which is the one thing a
 * traceability view exists to answer.
 *
 * Two of the six already exist as first-class objects (`screen`, `pin`); the
 * other four are stored in `obj` through the kind/subtype pair the schema
 * already defines, so adding the graph needed no new node table:
 *
 *   req      → specnode / requirement
 *   policy   → specnode / policy
 *   contract → contract
 *   qa       → verification
 */
export const GRAPH_NODE_TYPES = ['screen', 'pin', 'req', 'policy', 'contract', 'qa'] as const;
export const GraphNodeTypeSchema = z.enum(GRAPH_NODE_TYPES);
export type GraphNodeType = z.infer<typeof GraphNodeTypeSchema>;

/** The four the graph view creates and edits; screen and pin come from the studio. */
export const EDITABLE_NODE_TYPES = ['req', 'policy', 'contract', 'qa'] as const;
export const EditableNodeTypeSchema = z.enum(EDITABLE_NODE_TYPES);
export type EditableNodeType = z.infer<typeof EditableNodeTypeSchema>;

export const NODE_TYPE_LABEL: Record<GraphNodeType, string> = {
  screen: '화면',
  pin: '핀',
  req: '요구사항',
  policy: '정책',
  contract: '계약',
  qa: 'QA',
};

/** Short badge text used on the graph canvas and in the traceability table. */
export const NODE_TYPE_BADGE: Record<GraphNodeType, string> = {
  screen: 'SCR',
  pin: 'PIN',
  req: 'REQ',
  policy: 'POL',
  contract: 'CON',
  qa: 'QA',
};

export const NODE_TYPE_KIND: Record<GraphNodeType, { kind: ObjectKind; subtype: string | null }> = {
  screen: { kind: 'screen', subtype: null },
  pin: { kind: 'pin', subtype: null },
  req: { kind: 'specnode', subtype: 'requirement' },
  policy: { kind: 'specnode', subtype: 'policy' },
  // `obj` requires a contract subtype; a graph contract starts as an API one.
  contract: { kind: 'contract', subtype: 'api' },
  qa: { kind: 'verification', subtype: null },
};

/** A new object of this type starts in this state (the schema's first state). */
export const NODE_TYPE_INITIAL_STATE: Record<EditableNodeType, string> = {
  req: 'draft',
  policy: 'draft',
  contract: 'draft',
  qa: 'blocked',
};

export function nodeTypeOf(kind: string, subtype: string | null): GraphNodeType | null {
  if (kind === 'screen') return 'screen';
  if (kind === 'pin') return 'pin';
  if (kind === 'contract') return 'contract';
  if (kind === 'verification') return 'qa';
  if (kind === 'specnode' && subtype === 'requirement') return 'req';
  if (kind === 'specnode' && subtype === 'policy') return 'policy';
  return null;
}

export const GRAPH_LINK_TYPES = [
  'implements',
  'governs',
  'handles_edge',
  'verifies',
  'references',
  'derived_from',
  'blocks',
] as const;
export const GraphLinkTypeSchema = z.enum(GRAPH_LINK_TYPES);
export type GraphLinkType = z.infer<typeof GraphLinkTypeSchema>;

export const GRAPH_LINK_LABEL: Record<GraphLinkType, string> = {
  implements: '구현한다',
  governs: '규율한다',
  handles_edge: '예외를 처리한다',
  verifies: '검증한다',
  references: '참조한다',
  derived_from: '도출된다',
  blocks: '막는다',
};

/**
 * Which node types a link may join. This mirrors the `link_type` registry in
 * `schema.sql` / `migrate-13-14.sql`; the daemon validates commands against it
 * before the store's trigger does, so a mistake reads as a sentence.
 */
export const GRAPH_LINK_ENDS: Record<GraphLinkType, { src: GraphNodeType[]; dst: GraphNodeType[] }> = {
  implements: { src: ['screen', 'pin'], dst: ['req'] },
  governs: { src: ['policy'], dst: ['screen', 'pin', 'req'] },
  handles_edge: { src: ['pin', 'screen', 'req'], dst: ['req', 'policy'] },
  verifies: { src: ['qa'], dst: ['screen', 'pin', 'req', 'policy', 'contract'] },
  references: {
    src: ['screen', 'pin', 'req', 'policy', 'contract', 'qa'],
    dst: ['screen', 'pin', 'req', 'policy', 'contract', 'qa'],
  },
  derived_from: {
    src: ['req', 'policy', 'contract', 'qa'],
    dst: ['req', 'policy', 'contract', 'qa', 'pin'],
  },
  blocks: {
    src: ['req', 'policy', 'contract', 'qa', 'pin'],
    dst: ['req', 'policy', 'contract', 'qa', 'pin'],
  },
};

export function linkEndsAllow(
  type: GraphLinkType,
  srcType: GraphNodeType | null,
  dstType: GraphNodeType | null,
): boolean {
  if (srcType === null || dstType === null) return false;
  const ends = GRAPH_LINK_ENDS[type];
  return ends.src.includes(srcType) && ends.dst.includes(dstType);
}

/** One node as the graph view renders it. Editable kinds are stored in `project.graph`. */
export const GraphNodeSchema = z.object({
  id: ObjectIdSchema,
  type: EditableNodeTypeSchema,
  title: z.string().min(1).max(200),
  body: z.string().max(4000).default(''),
  state: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

/**
 * A named edge. `suspect` is not a second kind of link — it is the same link
 * after an endpoint moved, kept while a person re-reads it. The reason travels
 * with it so the badge can say why instead of only that something changed.
 */
export const GraphLinkSchema = z.object({
  id: z.string().regex(/^L_[A-Za-z0-9_-]{8,24}$/, { message: 'link id must start with L_' }),
  type: GraphLinkTypeSchema,
  src: ObjectIdSchema,
  dst: ObjectIdSchema,
  suspectSince: z.string().min(1).nullable().default(null),
  suspectWhy: z.string().max(200).nullable().default(null),
  createdAt: z.string().min(1),
});
export type GraphLink = z.infer<typeof GraphLinkSchema>;

export const GraphSchema = z.object({
  nodes: z.array(GraphNodeSchema).default([]),
  links: z.array(GraphLinkSchema).default([]),
});
export type Graph = z.infer<typeof GraphSchema>;

export const emptyGraph = (): Graph => ({ nodes: [], links: [] });

// ── the pin-derived proposal ──────────────────────────────────────────────

export const GRAPH_PROPOSAL_STATES = ['open', 'adopted', 'rejected', 'reverted'] as const;
export const GraphProposalStateSchema = z.enum(GRAPH_PROPOSAL_STATES);
export type GraphProposalState = z.infer<typeof GraphProposalStateSchema>;

/**
 * A reference inside a proposal. Ids do not exist until adoption, so a link
 * names its ends symbolically:
 *   item:<key>   a node this proposal would create
 *   pin:<id>     an existing pin
 *   node:<id>    any existing object (screen, req, policy, contract, qa)
 */
export const ProposalRefSchema = z
  .string()
  .regex(/^(item|pin|node):[A-Za-z0-9_-]{3,40}$/, {
    message: 'a proposal ref is item:<key>, pin:<id> or node:<id>',
  });

export const GraphProposalNodeSchema = z.object({
  key: z.string().min(1).max(24),
  type: EditableNodeTypeSchema,
  title: z.string().min(1).max(200),
  body: z.string().max(4000).default(''),
  /** The pin the sentence was read from — the card shows it next to the draft. */
  pinId: PinIdSchema.nullable().default(null),
});
export type GraphProposalNode = z.infer<typeof GraphProposalNodeSchema>;

export const GraphProposalLinkSchema = z.object({
  type: GraphLinkTypeSchema,
  src: ProposalRefSchema,
  dst: ProposalRefSchema,
});
export type GraphProposalLink = z.infer<typeof GraphProposalLinkSchema>;

export const GraphProposalSchema = z.object({
  id: z.string().regex(/^GP_[A-Za-z0-9_-]{8,24}$/, {
    message: 'graph proposal id must start with GP_',
  }),
  summary: z.string().min(1).max(300),
  state: GraphProposalStateSchema,
  nodes: z.array(GraphProposalNodeSchema).max(60),
  links: z.array(GraphProposalLinkSchema).max(200),
  createdAt: z.string().min(1),
  decidedAt: z.string().min(1).nullable().default(null),
});
export type GraphProposal = z.infer<typeof GraphProposalSchema>;
