import { z } from 'zod';

/**
 * The seven object kinds a project is made of. The kind is immutable:
 * changing it means creating a new object and linking with `supersedes`.
 */
export const OBJECT_KINDS = [
  'goal',
  'insight',
  'specnode',
  'screen',
  'pin',
  'contract',
  'verification',
] as const;

export const ObjectKindSchema = z.enum(OBJECT_KINDS);
export type ObjectKind = (typeof OBJECT_KINDS)[number];

/** Every object id starts with the letter of its kind, then a random suffix. */
export const ID_PREFIX: Record<ObjectKind, string> = {
  goal: 'G',
  insight: 'I',
  specnode: 'N',
  screen: 'S',
  pin: 'P',
  contract: 'C',
  verification: 'V',
};

const SUFFIX = '[A-Za-z0-9_-]{8,24}';
const PREFIXES = Object.values(ID_PREFIX).join('|');

export const ObjectIdSchema = z
  .string()
  .regex(new RegExp(`^(?:${PREFIXES})_${SUFFIX}$`), {
    message: 'object id must be "<kind prefix>_<8-24 chars>"',
  });

export const ScreenIdSchema = z
  .string()
  .regex(new RegExp(`^S_${SUFFIX}$`), { message: 'screen id must start with S_' });

export const PinIdSchema = z
  .string()
  .regex(new RegExp(`^P_${SUFFIX}$`), { message: 'pin id must start with P_' });

export function idPrefixFor(kind: ObjectKind): string {
  return ID_PREFIX[kind];
}
