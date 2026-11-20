import { z } from 'zod';
import { PinIdSchema } from './ids.js';

/**
 * A document is the prose side of a screen: the paragraphs a person reads,
 * each one allowed to stand on the numbered pins the screen already carries.
 * Blocks have stable ids because a proposal, a citation and a revert all need
 * to name the same paragraph before and after an edit. A project keeps a
 * registry of these, and a deleted row stays (tombstoned) rather than leaving.
 */
export const DocIdSchema = z
  .string()
  .regex(/^D_[A-Za-z0-9_-]{8,24}$/, { message: 'doc id must start with D_' });
export const BlockIdSchema = z
  .string()
  .regex(/^B_[A-Za-z0-9_-]{8,24}$/, { message: 'block id must start with B_' });
export const ProposalIdSchema = z
  .string()
  .regex(/^PR_[A-Za-z0-9_-]{8,24}$/, { message: 'proposal id must start with PR_' });

export type DocId = z.infer<typeof DocIdSchema>;
export type BlockId = z.infer<typeof BlockIdSchema>;
export type ProposalId = z.infer<typeof ProposalIdSchema>;

/**
 * The four block types v1 edits. The schema knows more (table cells, figures,
 * code), but a paragraph-level editor that cannot render them would delete
 * what it cannot see, so they are added when the editor can.
 */
export const BLOCK_TYPES = ['paragraph', 'heading', 'list', 'caption'] as const;
export const BlockTypeSchema = z.enum(BLOCK_TYPES);
export type BlockType = z.infer<typeof BlockTypeSchema>;

export const BLOCK_TYPE_LABEL: Record<BlockType, string> = {
  paragraph: '문단',
  heading: '제목',
  list: '목록',
  caption: '캡션',
};

/**
 * What a document is for. `spec` is the prose a screen's pins stand under;
 * `research` is notes that may cite the same pins without being the spec.
 */
export const DOC_KINDS = ['spec', 'research'] as const;
export const DocKindSchema = z.enum(DOC_KINDS);
export type DocKind = z.infer<typeof DocKindSchema>;

/**
 * A pin a block stands on. `fingerprint` is the pin's spec (type · title ·
 * body) at the moment the link was made or last confirmed, and it is what
 * decides the `stale` badge: dragging a pin's anchor moves the pin without
 * making the sentence false, so the anchor is deliberately not part of it.
 */
export const BlockPinRefSchema = z.object({
  pinId: PinIdSchema,
  fingerprint: z.string().min(1).max(64),
  linkedAt: z.string().min(1),
});

export type BlockPinRef = z.infer<typeof BlockPinRefSchema>;

export const BlockSchema = z.object({
  id: BlockIdSchema,
  type: BlockTypeSchema,
  text: z.string().max(8000),
  pinRefs: z.array(BlockPinRefSchema).max(24),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type Block = z.infer<typeof BlockSchema>;

export const DocSchema = z.object({
  id: DocIdSchema,
  title: z.string().min(1).max(120),
  /** Commit counter: one increment per adopted command, not per keystroke. */
  rev: z.number().int().min(0),
  blocks: z.array(BlockSchema),
  /** What the document is for; the registry may hold spec and research notes. */
  kind: DocKindSchema.default('spec'),
  /** Set the moment the row was tombstoned; live docs always carry null. */
  deletedAt: z.string().nullable().default(null),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type Doc = z.infer<typeof DocSchema>;

/**
 * Why a block needs a person's eye. `pin-changed` means the pin's type, title
 * or body moved on since the link was confirmed; `pin-missing` means the pin
 * the sentence cites is gone (a deleted number is never reused, so the sentence
 * now points at nothing).
 */
export const STALE_REASONS = ['pin-changed', 'pin-missing'] as const;
export const StaleReasonSchema = z.enum(STALE_REASONS);
export type StaleReason = z.infer<typeof StaleReasonSchema>;

export const BlockStaleSchema = z.object({
  blockId: BlockIdSchema,
  pinId: PinIdSchema,
  reason: StaleReasonSchema,
});
export type BlockStale = z.infer<typeof BlockStaleSchema>;
