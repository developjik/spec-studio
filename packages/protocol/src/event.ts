import { z } from 'zod';
import { PinIdSchema, ScreenIdSchema } from './ids';
import { PinSchema } from './pin';
import { ScreenSchema } from './screen';

/** What a command did. Applied events get a global monotonic `seq`. */
export const EventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('screen.attached'),
    screen: ScreenSchema,
  }),
  z.object({
    type: z.literal('pin.created'),
    pin: PinSchema,
  }),
  z.object({
    type: z.literal('pin.updated'),
    pin: PinSchema,
  }),
  z.object({
    type: z.literal('pin.deleted'),
    screenId: ScreenIdSchema,
    pinId: PinIdSchema,
    /** Kept in the event so downstream copies can leave the same gap. */
    number: z.number().int().min(1),
  }),
]);

export type DomainEvent = z.infer<typeof EventSchema>;

export const EventEnvelopeSchema = z.object({
  seq: z.number().int().min(1),
  at: z.string().min(1),
  event: EventSchema,
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
