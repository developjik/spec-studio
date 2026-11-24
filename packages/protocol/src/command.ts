import { z } from 'zod';
import { AiBriefDraftSchema, AiDocDraftSchema, AiGraphDraftSchema, AiProposalSourceSchema } from './ai';
import { BlockIdSchema, BlockTypeSchema, DocIdSchema, DocKindSchema, ProposalIdSchema } from './doc';
import { EvidenceIdSchema, EvidenceTypeSchema, EVIDENCE_EXCERPT_MAX } from './evidence';
import {
  EditableNodeTypeSchema,
  GraphLinkTypeSchema,
} from './graph';
import { IdeaIdSchema, IdeaStateSchema } from './idea';
import { ObjectIdSchema, PinIdSchema, ScreenIdSchema } from './ids';
import { AnchorSchema, PinTypeSchema, PinTypeSchema as TypeSchema } from './pin';
import { ScreenSchema } from './screen';

/**
 * Commands are the only way state changes. The renderer sends them; a store
 * or daemon applies them in one transaction and emits the resulting events.
 * No command can set a pin's number — numbers are allocated, never assigned.
 */
export const CommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('screen.attach'),
    screen: ScreenSchema,
  }),
  z.object({
    type: z.literal('pin.create'),
    screenId: ScreenIdSchema,
    pinType: TypeSchema,
    title: z.string().trim().min(1).max(120),
    body: z.string().max(4000),
    anchor: AnchorSchema,
  }),
  z.object({
    type: z.literal('pin.update'),
    screenId: ScreenIdSchema,
    pinId: PinIdSchema,
    pinType: PinTypeSchema.optional(),
    title: z.string().trim().min(1).max(120).optional(),
    body: z.string().max(4000).optional(),
    /**
     * A drag on the screen is the same edit: the anchor moves, the number
     * does not. Kept on `pin.update` so repositioning has one write path.
     */
    anchor: AnchorSchema.optional(),
  }),
  z.object({
    type: z.literal('screen.update'),
    screenId: ScreenIdSchema,
    /** Display name of the screen in the pin list and the published copy. */
    title: z.string().trim().min(1).max(120).optional(),
    /** Registered Figma frame; `null` removes it. Never fetched, only linked. */
    figmaUrl: z.string().url().max(2048).nullable().optional(),
  }),
  z.object({
    type: z.literal('pin.delete'),
    screenId: ScreenIdSchema,
    pinId: PinIdSchema,
  }),

  // ── idea inbox · research board (E1 §4 F2·F3) ────────────────────────
  /** `tags` are classified by rule and `title` is the first line of `text`. */
  z.object({
    type: z.literal('idea.capture'),
    text: z.string().trim().min(1).max(8000),
    url: z.string().url().max(2048).optional(),
    image: z.string().max(500).optional(),
  }),
  /** State moves only `captured → promoted | archived`; text edits are free. */
  z.object({
    type: z.literal('idea.update'),
    ideaId: IdeaIdSchema,
    text: z.string().trim().min(1).max(8000).optional(),
    url: z.string().url().max(2048).optional(),
    image: z.string().max(500).optional(),
    state: IdeaStateSchema.optional(),
  }),
  z.object({ type: z.literal('idea.archive'), ideaId: IdeaIdSchema }),
  /** Excerpt ceiling is R6's 짧은 인용 원칙, enforced at the schema. */
  z.object({
    type: z.literal('evidence.capture'),
    url: z.string().url().max(2048),
    title: z.string().trim().min(1).max(200).optional(),
    excerpt: z.string().max(EVIDENCE_EXCERPT_MAX),
    evidenceType: EvidenceTypeSchema,
  }),
  z.object({
    type: z.literal('evidence.update'),
    evidenceId: EvidenceIdSchema,
    title: z.string().trim().min(1).max(200).optional(),
    excerpt: z.string().max(EVIDENCE_EXCERPT_MAX).optional(),
    url: z.string().url().max(2048).optional(),
  }),
  z.object({ type: z.literal('evidence.dismiss'), evidenceId: EvidenceIdSchema }),

  // ── document registry (W3/F5) ─────────────────────────────────────────
  z.object({
    type: z.literal('doc.create'),
    title: z.string().trim().min(1).max(120),
    kind: DocKindSchema.default('spec'),
  }),
  z.object({
    type: z.literal('doc.update'),
    docId: DocIdSchema,
    title: z.string().trim().min(1).max(120),
  }),
  z.object({ type: z.literal('doc.delete'), docId: DocIdSchema }),

  // ── document blocks (W4) ─────────────────────────────────────────────
  z.object({
    type: z.literal('doc.block.create'),
    docId: DocIdSchema,
    blockType: BlockTypeSchema,
    text: z.string().max(8000),
    /** Omitted appends at the end; `null` puts it at the top of the document. */
    afterBlockId: BlockIdSchema.nullable().optional(),
  }),
  z.object({
    type: z.literal('doc.block.update'),
    docId: DocIdSchema,
    blockId: BlockIdSchema,
    text: z.string().max(8000).optional(),
    blockType: BlockTypeSchema.optional(),
  }),
  z.object({
    type: z.literal('doc.block.delete'),
    docId: DocIdSchema,
    blockId: BlockIdSchema,
  }),
  z.object({
    type: z.literal('doc.block.move'),
    docId: DocIdSchema,
    blockId: BlockIdSchema,
    /** The block to follow; `null` moves it to the top. */
    afterBlockId: BlockIdSchema.nullable(),
  }),
  z.object({
    type: z.literal('doc.pin.link'),
    docId: DocIdSchema,
    blockId: BlockIdSchema,
    pinId: PinIdSchema,
  }),
  z.object({
    type: z.literal('doc.pin.unlink'),
    docId: DocIdSchema,
    blockId: BlockIdSchema,
    pinId: PinIdSchema,
  }),
  /**
   * A person looked at a stale badge and accepted the text as it is. The link
   * keeps its pin and takes the pin's current spec as the new baseline; for a
   * pin that no longer exists the link itself is what is cleared.
   */
  z.object({
    type: z.literal('doc.stale.clear'),
    docId: DocIdSchema,
    blockId: BlockIdSchema,
    pinId: PinIdSchema,
  }),

  // ── proposal layer (W4) ──────────────────────────────────────────────
  z.object({
    type: z.literal('proposal.create'),
    docId: DocIdSchema,
    /**
     * A draft produced outside core — by a model — already validated against
     * its draft schema. `claims` means a research brief (F3-2), which the
     * store turns into insert patches; `patches` rewrite existing blocks.
     * Absent, the rule-based builder runs as before. The daemon never passes
     * a model's prose through: only these shapes reach the store, and the
     * store still writes `op_log.before` when it is adopted.
     */
    draft: z.union([AiDocDraftSchema, AiBriefDraftSchema]).optional(),
    source: AiProposalSourceSchema.optional(),
    provider: z.string().max(40).nullable().optional(),
    model: z.string().max(80).nullable().optional(),
  }),
  z.object({
    type: z.literal('proposal.adopt'),
    docId: DocIdSchema,
    proposalId: ProposalIdSchema,
  }),
  z.object({
    type: z.literal('proposal.reject'),
    docId: DocIdSchema,
    proposalId: ProposalIdSchema,
  }),

  z.object({ type: z.literal('proposal.defer'), docId: DocIdSchema, proposalId: ProposalIdSchema }),

  // ── object graph (v1) ─────────────────────────────────────────────────
  z.object({
    type: z.literal('node.create'),
    nodeType: EditableNodeTypeSchema,
    title: z.string().trim().min(1).max(200),
    body: z.string().max(4000).default(''),
  }),
  z.object({
    type: z.literal('node.update'),
    nodeId: ObjectIdSchema,
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(4000).optional(),
    state: z.string().min(1).max(40).optional(),
  }),
  z.object({
    type: z.literal('node.delete'),
    nodeId: ObjectIdSchema,
  }),
  z.object({
    type: z.literal('link.create'),
    linkType: GraphLinkTypeSchema,
    src: ObjectIdSchema,
    dst: ObjectIdSchema,
  }),
  z.object({
    type: z.literal('link.delete'),
    linkId: z.string().min(1),
  }),
  /** A person read the suspect link and says it still holds. */
  z.object({
    type: z.literal('link.ack'),
    linkId: z.string().min(1),
  }),
  /** Reads the screen's pins and drafts policy / req / qa nodes plus their links. */
  z.object({
    type: z.literal('graph.proposal.create'),
    /** A model-built draft; absent means the rule extractor builds the card. */
    draft: AiGraphDraftSchema.optional(),
    source: AiProposalSourceSchema.optional(),
    provider: z.string().max(40).nullable().optional(),
    model: z.string().max(80).nullable().optional(),
  }),
  z.object({
    type: z.literal('graph.proposal.adopt'),
    proposalId: z.string().min(1),
  }),
  z.object({
    type: z.literal('graph.proposal.reject'),
    proposalId: z.string().min(1),
  }),

  // ── project ──────────────────────────────────────────────────────────
  /** Trim and emptiness are core's call, so both modes answer `invalid_input`. */
  z.object({
    type: z.literal('project.rename'),
    name: z.string().max(120),
  }),

  // ── handoff package (F4) ─────────────────────────────────────────────
  z.object({
    type: z.literal('project.package.export'),
    /** The file names the package wrote — the ledger says what shipped. */
    files: z.array(z.string().min(1).max(120)).min(1).max(16),
  }),
]);

export type Command = z.infer<typeof CommandSchema>;
export type PinCreateCommand = Extract<Command, { type: 'pin.create' }>;
export type PinUpdateCommand = Extract<Command, { type: 'pin.update' }>;
export type PinDeleteCommand = Extract<Command, { type: 'pin.delete' }>;
export type ScreenAttachCommand = Extract<Command, { type: 'screen.attach' }>;
export type ScreenUpdateCommand = Extract<Command, { type: 'screen.update' }>;
export type ProjectRenameCommand = Extract<Command, { type: 'project.rename' }>;
export type DocCreateCommand = Extract<Command, { type: 'doc.create' }>;
export type DocUpdateCommand = Extract<Command, { type: 'doc.update' }>;
export type DocDeleteCommand = Extract<Command, { type: 'doc.delete' }>;
export type IdeaCaptureCommand = Extract<Command, { type: 'idea.capture' }>;
export type IdeaUpdateCommand = Extract<Command, { type: 'idea.update' }>;
export type EvidenceCaptureCommand = Extract<Command, { type: 'evidence.capture' }>;
export type DocBlockCreateCommand = Extract<Command, { type: 'doc.block.create' }>;
export type DocBlockUpdateCommand = Extract<Command, { type: 'doc.block.update' }>;
export type ProposalCreateCommand = Extract<Command, { type: 'proposal.create' }>;
export type ProposalAdoptCommand = Extract<Command, { type: 'proposal.adopt' }>;
export type NodeCreateCommand = Extract<Command, { type: 'node.create' }>;
export type LinkCreateCommand = Extract<Command, { type: 'link.create' }>;
export type GraphProposalAdoptCommand = Extract<Command, { type: 'graph.proposal.adopt' }>;
