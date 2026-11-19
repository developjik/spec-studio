import { z } from 'zod';
import { ScreenIdSchema } from './ids';

/**
 * How a screen is referenced before any implementation exists:
 *  - image:       an uploaded/pasted screenshot, stored as a data URL
 *  - figma_frame: a Figma frame URL registered by the user
 *  - route:       an app route, once implementation starts
 */
export const ScreenRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('image'),
    value: z.string().min(1),
    label: z.string().min(1).max(120).optional(),
  }),
  z.object({
    kind: z.literal('figma_frame'),
    value: z.string().url(),
    label: z.string().min(1).max(120).optional(),
  }),
  z.object({
    kind: z.literal('route'),
    value: z.string().min(1),
    label: z.string().min(1).max(120).optional(),
  }),
]);

export type ScreenRef = z.infer<typeof ScreenRefSchema>;

export const ViewportSchema = z.object({
  width: z.number().int().min(1).max(20000),
  height: z.number().int().min(1).max(20000),
});

export const ScreenSchema = z.object({
  id: ScreenIdSchema,
  /** Human label shown in the pin list, e.g. "주문 상세". */
  title: z.string().min(1).max(120),
  /** Short code used in pin labels, e.g. SCR-110 → SCR-110-3. */
  code: z.string().regex(/^SCR-\d{2,4}$/, { message: 'screen code must look like SCR-110' }),
  ref: ScreenRefSchema,
  /**
   * The Figma frame this screen was designed in, when one is registered. It is
   * reference data, not state: the spec stays local and the link travels into
   * the published copy. `null` means no frame is registered.
   */
  figmaUrl: z.string().url().nullable().optional(),
  viewport: ViewportSchema.nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type Screen = z.infer<typeof ScreenSchema>;
