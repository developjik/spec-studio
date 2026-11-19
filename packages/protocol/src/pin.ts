import { z } from 'zod';
import { PinIdSchema, ScreenIdSchema } from './ids.js';

/**
 * Six pin types exist in the schema. v1 shows only the first three — the
 * first day should not require memorising a taxonomy. Adding a type later is
 * a flag change, not a data migration.
 */
export const PIN_TYPES = [
  'function',
  'policy',
  'exception',
  'state',
  'data',
  'permission',
] as const;

export const PinTypeSchema = z.enum(PIN_TYPES);
export type PinType = (typeof PIN_TYPES)[number];

export const V1_PIN_TYPES = ['function', 'policy', 'exception'] as const;
export const V1PinTypeSchema = z.enum(V1_PIN_TYPES);
export type V1PinType = (typeof V1_PIN_TYPES)[number];

export const PIN_TYPE_LABEL: Record<PinType, string> = {
  function: '기능',
  policy: '정책',
  exception: '예외',
  state: '상태',
  data: '데이터',
  permission: '권한',
};

/** Where the pin sits, as a fraction of the screen image's box (0..1). */
export const AnchorSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

export type Anchor = z.infer<typeof AnchorSchema>;

/**
 * A numbered pin on a screen. `number` is assigned once and never changes —
 * not when the pin is edited, not when a sibling is deleted, not when the
 * list is sorted. See `packages/core/src/pins.ts` for the rule.
 */
export const PinSchema = z.object({
  id: PinIdSchema,
  screenId: ScreenIdSchema,
  number: z.number().int().min(1).max(9999),
  type: PinTypeSchema,
  title: z.string().min(1).max(120),
  body: z.string().max(4000),
  anchor: AnchorSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type Pin = z.infer<typeof PinSchema>;
