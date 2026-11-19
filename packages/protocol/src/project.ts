import { z } from 'zod';
import { PinSchema } from './pin';
import { ScreenSchema } from './screen';

/**
 * W1 works on one screen per project. `pinSeq` is that screen's high-water
 * mark: the last number handed out. It is not "how many pins exist" — pins can
 * be deleted while the mark stays, which is what keeps numbers from being
 * reused.
 */
export const ProjectSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  screen: ScreenSchema.nullable(),
  pins: z.array(PinSchema),
  pinSeq: z.number().int().min(0),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type Project = z.infer<typeof ProjectSchema>;
