/** Returns a canonical URL only for HTTPS URLs hosted on Figma. */
export function parseFigmaUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname !== 'figma.com' && !url.hostname.endsWith('.figma.com')) return null;
  return url;
}
