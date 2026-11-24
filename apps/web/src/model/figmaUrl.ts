export const FIGMA_URL_FORMAT_ERROR =
  '주소 형식을 확인해 주세요. https://www.figma.com/… 처럼 입력합니다.';
export const FIGMA_URL_HTTPS_ERROR = 'https:// 주소만 등록할 수 있습니다.';

/** Return the user-facing error for malformed or insecure Figma URL input. */
export function figmaUrlInputError(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return FIGMA_URL_FORMAT_ERROR;
  }

  return url.protocol === 'https:' ? null : FIGMA_URL_HTTPS_ERROR;
}
