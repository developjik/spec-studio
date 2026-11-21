/**
 * The static HTML has to carry its own image: a handoff file that phones home
 * for a screenshot is a broken handoff. Browsers have `btoa`, Node has Buffer,
 * and core may use neither — so the encoder lives here, six lines of lookup.
 */
import { parseImageDataUrl } from '@spec-studio/protocol';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function base64FromBytes(bytes: Uint8Array): string {
  let out = '';
  let index = 0;

  for (; index + 2 < bytes.length; index += 3) {
    const chunk = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    out +=
      ALPHABET.charAt((chunk >> 18) & 63) +
      ALPHABET.charAt((chunk >> 12) & 63) +
      ALPHABET.charAt((chunk >> 6) & 63) +
      ALPHABET.charAt(chunk & 63);
  }

  const rest = bytes.length - index;
  if (rest === 1) {
    const chunk = (bytes[index] ?? 0) << 16;
    out += `${ALPHABET.charAt((chunk >> 18) & 63)}${ALPHABET.charAt((chunk >> 12) & 63)}==`;
  } else if (rest === 2) {
    const chunk = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8);
    out += `${ALPHABET.charAt((chunk >> 18) & 63)}${ALPHABET.charAt((chunk >> 12) & 63)}${ALPHABET.charAt(
      (chunk >> 6) & 63,
    )}=`;
  }

  return out;
}

export interface InlinedImage {
  mime: string;
  base64: string;
  /** A data URL a browser opens without asking anyone for bytes. */
  dataUrl: string;
}

/**
 * Screenshots arrive either as `...;base64,<payload>` (PNG, WebP, JPEG) or as
 * a percent-encoded SVG. Both become one base64 data URL, so the generated
 * document has exactly one shape to reason about.
 *
 * The string is parsed by the protocol's `parseImageDataUrl`, not by hand: only
 * an allowlisted image mime and a clean payload get through, so the data URL
 * this returns cannot carry a quote, a `<` or a `text/html` type into the HTML
 * attribute it is written to. A bundle that says otherwise is rejected here,
 * before an `<img>` is ever rendered.
 */
export function inlineImage(rawDataUrl: string): InlinedImage {
  const parsed = parseImageDataUrl(rawDataUrl);
  if (parsed === null) {
    throw new Error(
      'screen image must be a data URL of an allowed image type (png, jpeg, webp, gif, avif, svg+xml)',
    );
  }

  if (parsed.base64) {
    return { mime: parsed.mime, base64: parsed.payload, dataUrl: `data:${parsed.mime};base64,${parsed.payload}` };
  }

  const base64 = base64FromBytes(utf8Bytes(decodeURIComponent(parsed.payload)));
  return { mime: parsed.mime, base64, dataUrl: `data:${parsed.mime};base64,${base64}` };
}

/** File-system safe slug: `SCR-110` → `scr-110`. */
export function slug(text: string): string {
  const lowered = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return lowered === '' ? 'screen' : lowered;
}
