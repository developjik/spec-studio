/**
 * The static HTML has to carry its own image: a handoff file that phones home
 * for a screenshot is a broken handoff. Browsers have `btoa`, Node has Buffer,
 * and core may use neither — so the encoder lives here, six lines of lookup.
 */
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
 */
export function inlineImage(rawDataUrl: string): InlinedImage {
  const comma = rawDataUrl.indexOf(',');
  if (!rawDataUrl.startsWith('data:') || comma < 0) {
    throw new Error('screen image must be a data url');
  }

  const header = rawDataUrl.slice('data:'.length, comma);
  const payload = rawDataUrl.slice(comma + 1);
  const mime = header.split(';')[0]?.trim() || 'application/octet-stream';

  if (/;\s*base64/i.test(header)) {
    const base64 = payload.replace(/\s+/g, '');
    return { mime, base64, dataUrl: `data:${mime};base64,${base64}` };
  }

  const base64 = base64FromBytes(utf8Bytes(decodeURIComponent(payload)));
  return { mime, base64, dataUrl: `data:${mime};base64,${base64}` };
}

/** File-system safe slug: `SCR-110` → `scr-110`. */
export function slug(text: string): string {
  const lowered = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return lowered === '' ? 'screen' : lowered;
}
