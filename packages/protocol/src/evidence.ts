import { z } from 'zod';

/**
 * The research board's source object (§4 F3-1). An evidence row is a short
 * quote with the link it came from — R6's rule that a brief may quote, never
 * copy, lives in the 2,000-character ceiling on `excerpt`. Being cited by a
 * `references` link moves it from `captured` to `cited`.
 */
export const EvidenceIdSchema = z
  .string()
  .regex(/^E_[A-Za-z0-9_-]{8,24}$/, { message: 'evidence id must start with E_' });
export type EvidenceId = z.infer<typeof EvidenceIdSchema>;

export const EVIDENCE_STATES = ['captured', 'cited', 'dismissed'] as const;
export const EvidenceStateSchema = z.enum(EVIDENCE_STATES);
export type EvidenceState = z.infer<typeof EvidenceStateSchema>;

export const EVIDENCE_TYPES = ['web', 'pdf', 'image', 'text'] as const;
export const EvidenceTypeSchema = z.enum(EVIDENCE_TYPES);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

/** R6: 발췌는 짧은 인용 — the schema is the ceiling, the UI adds the 안내 문구. */
export const EVIDENCE_EXCERPT_MAX = 2000;

export const EvidenceSchema = z.object({
  id: EvidenceIdSchema,
  title: z.string().min(1).max(200),
  url: z.string().url().max(2048),
  excerpt: z.string().max(EVIDENCE_EXCERPT_MAX),
  type: EvidenceTypeSchema,
  state: EvidenceStateSchema,
  capturedAt: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Evidence = z.infer<typeof EvidenceSchema>;
