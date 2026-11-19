import { z } from 'zod';
import { BlockIdSchema, BlockSchema, DocIdSchema, ProposalIdSchema } from './doc.js';

/**
 * A proposal is an edit that has not happened yet. It never touches the text:
 * it names blocks, keeps the state each block would leave and the state it
 * would arrive at, and waits for one decision. That is what makes the card
 * undoable — the store keeps the same "before" in `op_log` when it is adopted.
 */
export const PROPOSAL_ORIGINS = ['pin', 'screen', 'doc-chat'] as const;
export const ProposalOriginSchema = z.enum(PROPOSAL_ORIGINS);
export type ProposalOrigin = z.infer<typeof ProposalOriginSchema>;

export const PROPOSAL_STATES = ['open', 'adopted', 'rejected'] as const;
export const ProposalStateSchema = z.enum(PROPOSAL_STATES);
export type ProposalState = z.infer<typeof ProposalStateSchema>;

/** Exactly the fields a patch may change. Ids and positions are the store's. */
export const BlockStateSchema = z.object({
  type: BlockSchema.shape.type,
  text: BlockSchema.shape.text,
  pinRefs: BlockSchema.shape.pinRefs,
});
export type BlockState = z.infer<typeof BlockStateSchema>;

/**
 * One block's change. `before === null` means the patch adds a block that did
 * not exist; reverting such a patch removes it again.
 */
export const ProposalPatchSchema = z.object({
  blockId: BlockIdSchema,
  /** Where an added block lands: the block it follows, or null for the top. */
  afterBlockId: BlockIdSchema.nullable(),
  before: BlockStateSchema.nullable(),
  after: BlockStateSchema,
});
export type ProposalPatch = z.infer<typeof ProposalPatchSchema>;

export const ProposalSchema = z.object({
  id: ProposalIdSchema,
  docId: DocIdSchema,
  /** One line a person reads before deciding. */
  summary: z.string().min(1).max(300),
  origin: ProposalOriginSchema,
  /** The doc.rev the proposal was built on. */
  baseRev: z.number().int().min(0),
  state: ProposalStateSchema,
  patches: z.array(ProposalPatchSchema).min(1).max(50),
  createdAt: z.string().min(1),
  decidedAt: z.string().min(1).nullable(),
});

export type Proposal = z.infer<typeof ProposalSchema>;

/**
 * A snapshot of the blocks one operation touched — the value `op_log.before`
 * holds. Restoring it puts the document back exactly, including which blocks
 * existed, in what order, and which pins they stood on.
 */
export const BlockSnapshotEntrySchema = z.object({
  blockId: BlockIdSchema,
  /** False when the operation created the block; a revert removes it. */
  existed: z.boolean(),
  type: BlockSchema.shape.type.nullable(),
  text: z.string().nullable(),
  pinRefs: z.array(BlockSchema.shape.pinRefs.element).nullable(),
  /** Position among the document's blocks at snapshot time. */
  index: z.number().int().min(0),
});
export type BlockSnapshotEntry = z.infer<typeof BlockSnapshotEntrySchema>;

export const DocSnapshotSchema = z.object({
  docId: DocIdSchema,
  rev: z.number().int().min(0),
  entries: z.array(BlockSnapshotEntrySchema),
});
export type DocSnapshot = z.infer<typeof DocSnapshotSchema>;
