import { z } from 'zod';
import { ObjectIdSchema, ObjectKindSchema } from './ids';
import { PIN_TYPES } from './pin';

export const SPECNODE_SUBTYPES = ['ia', 'requirement', 'policy'] as const;
export const CONTRACT_SUBTYPES = ['api', 'state', 'event'] as const;

export const STATES_BY_KIND = {
  goal: ['proposed', 'active', 'done', 'dropped'],
  insight: ['ai', 'ai-verified', 'human'],
  screen: ['design', 'observed', 'linked', 'orphan'],
  pin: ['open', 'resolved', 'orphan'],
  contract: ['draft', 'agreed', 'applied'],
  verification: ['pass', 'fail', 'blocked'],
  idea: ['captured', 'promoted', 'archived'],
  evidence: ['captured', 'cited', 'dismissed'],
  specnode: [],
} as const satisfies Record<z.infer<typeof ObjectKindSchema>, readonly string[]>;

export const SPECNODE_STATES_BY_SUBTYPE = {
  ia: ['draft', 'agreed'],
  requirement: ['draft', 'approved', 'building', 'verified'],
  policy: ['draft', 'agreed', 'applied', 'superseded'],
} as const satisfies Record<(typeof SPECNODE_SUBTYPES)[number], readonly string[]>;

/**
 * One row of `obj`. The refinements below mirror the SQLite CHECK constraints
 * in `packages/store/schema/schema.sql`, so a value the database would reject
 * does not get through the protocol either.
 */
export const ObjectSchema = z
  .object({
    id: ObjectIdSchema,
    kind: ObjectKindSchema,
    subtype: z.string().min(1).nullable(),
    title: z.string().min(1).max(200),
    parentId: ObjectIdSchema.nullable(),
    props: z.record(z.string(), z.unknown()),
    state: z.string().min(1),
    rev: z.number().int().min(1),
    hash: z.string().min(1),
    deletedAt: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    const reject = (message: string, path: string[] = []) => {
      ctx.addIssue({ code: 'custom', message, path });
    };
    const inList = (list: readonly string[], candidate: string) => list.includes(candidate);

    if (value.kind === 'specnode') {
      const subtype = value.subtype ?? '';
      if (!inList(SPECNODE_SUBTYPES, subtype)) {
        reject('specnode requires subtype ia | requirement | policy', ['subtype']);
        return;
      }
      const key = subtype as (typeof SPECNODE_SUBTYPES)[number];
      const states = SPECNODE_STATES_BY_SUBTYPE[key];
      if (!inList(states, value.state)) {
        reject(`specnode/${key} state must be one of ${states.join(', ')}`, ['state']);
      }
      return;
    }

    if (value.kind === 'pin') {
      if (!value.subtype || !inList(PIN_TYPES, value.subtype)) {
        reject('pin requires subtype function | policy | exception | state | data | permission', [
          'subtype',
        ]);
      }
      if (value.parentId === null) reject('a pin cannot exist without its screen', ['parentId']);
      else if (!value.parentId.startsWith('S_')) reject('a pin parent must be a screen', ['parentId']);
      if (!inList(STATES_BY_KIND.pin, value.state)) {
        reject('pin state must be open | resolved | orphan', ['state']);
      }
      return;
    }

    if (value.kind === 'contract') {
      if (!value.subtype || !inList(CONTRACT_SUBTYPES, value.subtype)) {
        reject('contract requires subtype api | state | event', ['subtype']);
      }
      if (!inList(STATES_BY_KIND.contract, value.state)) {
        reject('contract state must be draft | agreed | applied', ['state']);
      }
      return;
    }

    // §5.2: idea·evidence는 홀로 선다 — subtype도 부모도 없다. 승격(promoted)은
    // 새 객체 + derived_from 링크로 표현하므로 parentId가 생기는 지점이 없다.
    if (value.kind === 'idea' || value.kind === 'evidence') {
      if (value.subtype !== null) reject(`${value.kind} has no subtype`, ['subtype']);
      if (value.parentId !== null) reject(`${value.kind} has no parent`, ['parentId']);
      const states = STATES_BY_KIND[value.kind];
      if (!inList(states, value.state)) {
        reject(`${value.kind} state must be one of ${states.join(', ')}`, ['state']);
      }
      return;
    }

    if (value.subtype !== null) reject(`${value.kind} has no subtype`, ['subtype']);
    const states: readonly string[] = STATES_BY_KIND[value.kind];
    if (!inList(states, value.state)) {
      reject(`${value.kind} state must be one of ${states.join(', ')}`, ['state']);
    }
  });

export type SpecObject = z.infer<typeof ObjectSchema>;
