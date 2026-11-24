import { z } from 'zod';
import { BlockIdSchema, BlockSchema, DocIdSchema, DocSchema, ProposalIdSchema } from './doc';
import { EvidenceSchema } from './evidence';
import { GraphLinkSchema, GraphNodeSchema, GraphProposalSchema } from './graph';
import { IdeaSchema } from './idea';
import { ObjectIdSchema, PinIdSchema, ScreenIdSchema } from './ids';
import { PinSchema } from './pin';
import { ProposalSchema } from './proposal';
import { ScreenSchema } from './screen';

/** What a command did. Applied events get a global monotonic `seq`. */
export const EventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('screen.selected'),
    screenId: ScreenIdSchema.nullable(),
  }),
  z.object({
    type: z.literal('screen.reordered'),
    screenIds: z.array(ScreenIdSchema),
  }),
  z.object({ type: z.literal('screen.deleted'), screenId: ScreenIdSchema }),
  z.object({
    type: z.literal('screen.attached'),
    screen: ScreenSchema,
  }),
  z.object({
    type: z.literal('screen.updated'),
    screen: ScreenSchema,
  }),
  z.object({
    type: z.literal('pin.created'),
    pin: PinSchema,
  }),
  z.object({
    type: z.literal('pin.updated'),
    pin: PinSchema,
  }),
  z.object({
    type: z.literal('pin.deleted'),
    screenId: ScreenIdSchema,
    pinId: PinIdSchema,
    /** Kept in the event so downstream copies can leave the same gap. */
    number: z.number().int().min(1),
  }),

  // ── idea inbox · research board (E1 §4 F2·F3) ────────────────────────
  z.object({ type: z.literal('idea.captured'), idea: IdeaSchema }),
  z.object({ type: z.literal('idea.updated'), idea: IdeaSchema }),
  z.object({ type: z.literal('idea.archived'), idea: IdeaSchema }),
  z.object({ type: z.literal('evidence.captured'), evidence: EvidenceSchema }),
  z.object({ type: z.literal('evidence.updated'), evidence: EvidenceSchema }),
  z.object({ type: z.literal('evidence.dismissed'), evidence: EvidenceSchema }),

  z.object({
    type: z.literal('project.renamed'),
    projectId: z.string().min(1),
    name: z.string().min(1),
  }),

  z.object({ type: z.literal('doc.attached'), doc: DocSchema }),
  z.object({ type: z.literal('doc.created'), doc: DocSchema }),
  z.object({
    type: z.literal('doc.renamed'),
    docId: DocIdSchema,
    title: z.string().min(1),
  }),
  z.object({ type: z.literal('doc.deleted'), docId: DocIdSchema }),
  z.object({ type: z.literal('block.created'), block: BlockSchema }),
  z.object({ type: z.literal('block.updated'), block: BlockSchema }),
  z.object({
    type: z.literal('block.deleted'),
    docId: DocIdSchema,
    blockId: BlockIdSchema,
  }),
  z.object({
    type: z.literal('block.moved'),
    docId: DocIdSchema,
    blockId: BlockIdSchema,
    afterBlockId: BlockIdSchema.nullable(),
  }),
  z.object({
    type: z.literal('block.pin.linked'),
    docId: DocIdSchema,
    blockId: BlockIdSchema,
    pinId: PinIdSchema,
  }),
  z.object({
    type: z.literal('block.pin.unlinked'),
    docId: DocIdSchema,
    blockId: BlockIdSchema,
    pinId: PinIdSchema,
  }),
  z.object({
    type: z.literal('block.stale.cleared'),
    docId: DocIdSchema,
    blockId: BlockIdSchema,
    pinId: PinIdSchema,
  }),
  z.object({ type: z.literal('proposal.created'), proposal: ProposalSchema }),
  z.object({
    type: z.literal('proposal.deferred'),
    docId: DocIdSchema,
    proposalId: ProposalIdSchema,
  }),
  z.object({
    type: z.literal('proposal.adopted'),
    docId: DocIdSchema,
    proposalId: ProposalIdSchema,
    summary: z.string().min(1),
  }),
  z.object({
    type: z.literal('proposal.rejected'),
    docId: DocIdSchema,
    proposalId: ProposalIdSchema,
  }),
  z.object({
    type: z.literal('doc.reverted'),
    docId: DocIdSchema,
    /** The `op_log.seq` this revert restored. */
    revertedSeq: z.number().int().min(1),
    blocks: z.number().int().min(0),
  }),
  /**
   * F4: a handoff package left the project. The state does not change — the
   * event is the record that six files went out, and `files` names them.
   */
  z.object({
    type: z.literal('package.exported'),
    files: z.array(z.string().min(1).max(120)).min(1).max(16),
  }),

  // ── object graph (v1) ─────────────────────────────────────────────────
  z.object({ type: z.literal('node.created'), node: GraphNodeSchema }),
  z.object({ type: z.literal('node.updated'), node: GraphNodeSchema }),
  z.object({ type: z.literal('node.deleted'), nodeId: ObjectIdSchema }),
  z.object({ type: z.literal('link.created'), link: GraphLinkSchema }),
  z.object({ type: z.literal('link.deleted'), linkId: z.string().min(1) }),
  z.object({ type: z.literal('link.acked'), linkId: z.string().min(1) }),
  z.object({
    type: z.literal('graph.proposal.created'),
    proposal: GraphProposalSchema,
  }),
  z.object({
    type: z.literal('graph.proposal.adopted'),
    proposalId: z.string().min(1),
    nodes: z.number().int().min(0),
    links: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('graph.proposal.rejected'),
    proposalId: z.string().min(1),
  }),
  z.object({
    type: z.literal('graph.proposal.reverted'),
    proposalId: z.string().min(1),
    nodes: z.number().int().min(0),
  }),
]);

export type DomainEvent = z.infer<typeof EventSchema>;

export const EventEnvelopeSchema = z.object({
  seq: z.number().int().min(1),
  at: z.string().min(1),
  event: EventSchema,
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
