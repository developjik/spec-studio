import { z } from 'zod';
import { PinIdSchema, ScreenIdSchema } from './ids';
import { AnchorSchema, PinTypeSchema, PinTypeSchema as TypeSchema } from './pin';
import { ScreenSchema } from './screen';

/**
 * Commands are the only way state changes. The renderer sends them; a store
 * or daemon applies them in one transaction and emits the resulting events.
 * No command can set a pin's number — numbers are allocated, never assigned.
 */
export const CommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('screen.attach'),
    screen: ScreenSchema,
  }),
  z.object({
    type: z.literal('pin.create'),
    screenId: ScreenIdSchema,
    pinType: TypeSchema,
    title: z.string().trim().min(1).max(120),
    body: z.string().max(4000),
    anchor: AnchorSchema,
  }),
  z.object({
    type: z.literal('pin.update'),
    screenId: ScreenIdSchema,
    pinId: PinIdSchema,
    pinType: PinTypeSchema.optional(),
    title: z.string().trim().min(1).max(120).optional(),
    body: z.string().max(4000).optional(),
    /**
     * A drag on the screen is the same edit: the anchor moves, the number
     * does not. Kept on `pin.update` so repositioning has one write path.
     */
    anchor: AnchorSchema.optional(),
  }),
  z.object({
    type: z.literal('screen.update'),
    screenId: ScreenIdSchema,
    /** Display name of the screen in the pin list and the published copy. */
    title: z.string().trim().min(1).max(120).optional(),
    /** Registered Figma frame; `null` removes it. Never fetched, only linked. */
    figmaUrl: z.string().url().max(2048).nullable().optional(),
  }),
  z.object({
    type: z.literal('pin.delete'),
    screenId: ScreenIdSchema,
    pinId: PinIdSchema,
  }),
]);

export type Command = z.infer<typeof CommandSchema>;
export type PinCreateCommand = Extract<Command, { type: 'pin.create' }>;
export type PinUpdateCommand = Extract<Command, { type: 'pin.update' }>;
export type PinDeleteCommand = Extract<Command, { type: 'pin.delete' }>;
export type ScreenAttachCommand = Extract<Command, { type: 'screen.attach' }>;
export type ScreenUpdateCommand = Extract<Command, { type: 'screen.update' }>;
