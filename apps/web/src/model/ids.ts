const SUFFIX_LENGTH = 12;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomSuffix(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ALPHABET.charAt(byte % ALPHABET.length);
  return out;
}

export function newScreenId(): string {
  return `S_${randomSuffix(SUFFIX_LENGTH)}`;
}

export function newPinId(): string {
  return `P_${randomSuffix(SUFFIX_LENGTH)}`;
}

export function newProjectId(): string {
  return `PRJ_${randomSuffix(SUFFIX_LENGTH)}`;
}
