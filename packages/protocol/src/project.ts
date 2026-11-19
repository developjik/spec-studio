import { z } from 'zod';
import { DocSchema } from './doc';
import { PinSchema } from './pin';
import { ProposalSchema } from './proposal';
import { ScreenSchema } from './screen';

/**
 * W1 works on one screen per project. `pinSeq` is that screen's high-water
 * mark: the last number handed out. It is not "how many pins exist" — pins can
 * be deleted while the mark stays, which is what keeps numbers from being
 * reused.
 *
 * W4 adds the document that stands beside the screen (`doc`) and the one
 * proposal currently on the table (`proposal`). They are part of the project
 * state because a command must change them in the same transaction as the
 * pins it reads, and because a reload must find them where it left them.
 */
export const ProjectSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  screen: ScreenSchema.nullable(),
  pins: z.array(PinSchema),
  pinSeq: z.number().int().min(0),
  doc: DocSchema.nullable().default(null),
  proposal: ProposalSchema.nullable().default(null),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type Project = z.infer<typeof ProjectSchema>;

export const ProjectFileSchema = ProjectSchema;
export type ProjectFile = Project;
