import { z } from 'zod';
import { AiProposalSourceSchema } from './ai.js';
import { BlockIdSchema, BlockSchema, DocIdSchema, ProposalIdSchema } from './doc.js';
import { IdeaIdSchema } from './idea.js';
import { RunIdSchema } from './agent.js';

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
  /**
   * v16 (MN-A): the idea a brief answers. Promotion reads it back so the
   * spec's seed survives a restart; anything not idea-born stays null.
   */
  ideaId: IdeaIdSchema.nullable().default(null),
  /**
   * E3 (W1): the run that produced this card, or null. Written to the
   * reserved `author_id` column — the store stamps the adoption's op_log
   * actor `ai:<runId>` from it, which is AC-1's provenance rule.
   */
  authorId: RunIdSchema.nullable().default(null),
  /**
   * E4 F3-③: who authored the card — a model answer or the rule extractor.
   * Written through the command's `source`; persisted inside the op's view
   * JSON (no column, no migration) so a reloaded card keeps its honest badge
   * instead of guessing `llm` from origin. `null` only on rows written
   * before this field existed.
   */
  source: AiProposalSourceSchema.nullable().default(null),
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
