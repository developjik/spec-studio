import { z } from 'zod';
import { ScreenIdSchema } from './ids';

/**
 * The image types a screen may carry. A screenshot is raster — plus SVG, which
 * the app's own sample screen uses — and nothing else. `text/html` and friends
 * are excluded because this string ends up as the `src` of an `<img>` in the
 * static handoff document, and a bundle can arrive from anywhere.
 */
export const SCREEN_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/svg+xml',
] as const;

export type ScreenImageMime = (typeof SCREEN_IMAGE_MIME_TYPES)[number];

export interface ParsedImageDataUrl {
  mime: ScreenImageMime;
  /** `true` when the payload was already base64, `false` for percent-encoded text. */
  base64: boolean;
  /** The payload exactly as it will be embedded (whitespace stripped when base64). */
  payload: string;
}

/** `image/jpg` is the same bytes as `image/jpeg`; keep one spelling. */
function normalizeImageMime(mime: string): string {
  const lower = mime.toLowerCase();
  return lower === 'image/jpg' ? 'image/jpeg' : lower;
}

/**
 * Reads a screen image data URL and says, without guessing, whether it is an
 * image this app is willing to embed.
 *
 * The whole test is deliberately narrow. The header must be `data:<allowed
 * image mime>` whose parameters are plain tokens (`base64`, `charset=utf-8`),
 * and the payload must be either base64 or URL-safe percent-encoding. That is
 * what stops an imported bundle from carrying `data:text/html` or a mime such
 * as `image/png" onerror="…` into the generated document: neither can survive
 * this function, and the only mime that leaves it is one of six fixed strings.
 */
export function parseImageDataUrl(value: string): ParsedImageDataUrl | null {
  if (!value.startsWith('data:')) return null;
  const comma = value.indexOf(',');
  if (comma < 0) return null;

  const parts = value.slice('data:'.length, comma).split(';');
  const mime = normalizeImageMime((parts[0] ?? '').trim());
  if (!(SCREEN_IMAGE_MIME_TYPES as readonly string[]).includes(mime)) return null;

  // Parameters are `;base64` or `;charset=utf-8` and nothing else: a quote, a
  // space or a `<` here is how an attribute injection would start.
  const params = parts.slice(1).map((param) => param.trim().toLowerCase());
  if (params.some((param) => !/^[a-z0-9=._-]+$/.test(param))) return null;

  const payload = value.slice(comma + 1);
  if (params.includes('base64')) {
    const compact = payload.replace(/\s+/g, '');
    if (compact === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
    return { mime: mime as ScreenImageMime, base64: true, payload: compact };
  }

  // A percent-encoded SVG. Only URL-safe characters, and it has to decode: the
  // document gets the base64 form, never this text, so nothing else rides along.
  if (payload === '' || !/^[A-Za-z0-9\-_.!~*'()%/:?@&=+$,]+$/.test(payload)) return null;
  try {
    if (decodeURIComponent(payload) === '') return null;
  } catch {
    return null;
  }
  return { mime: mime as ScreenImageMime, base64: false, payload };
}

/**
 * How a screen is referenced before any implementation exists:
 *  - image:       an uploaded/pasted screenshot, stored as a data URL
 *  - figma_frame: a Figma frame URL registered by the user
 *  - route:       an app route, once implementation starts
 */
export const ScreenRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('image'),
    value: z
      .string()
      .min(1)
      .refine((value) => parseImageDataUrl(value) !== null, {
        message:
          'screen image must be a data URL of an allowed image type (png, jpeg, webp, gif, avif, svg+xml)',
      }),
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
export type ScreenImageRef = Extract<ScreenRef, { kind: 'image' }>;

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
