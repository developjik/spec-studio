import { z } from 'zod';
import { BlockIdSchema, BlockSchema, DocIdSchema, DocSchema, ProposalIdSchema } from './doc';
import { PinIdSchema, ScreenIdSchema } from './ids';
import { PinSchema } from './pin';
import { ProposalSchema } from './proposal';
import { ScreenSchema } from './screen';

/** What a command did. Applied events get a global monotonic `seq`. */
export const EventSchema = z.discriminatedUnion('type', [
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

  z.object({ type: z.literal('doc.attached'), doc: DocSchema }),
  z.object({ type: z.literal('block.created'), block: BlockSchema }),
  z.object({ type: z.literal('block.updated'), block: BlockSchema }),
  z.object({ type: z.literal('block.deleted'), docId: DocIdSchema, blockId: BlockIdSchema }),
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
]);

export type DomainEvent = z.infer<typeof EventSchema>;

export const EventEnvelopeSchema = z.object({
  seq: z.number().int().min(1),
  at: z.string().min(1),
  event: EventSchema,
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
