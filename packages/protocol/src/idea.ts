import { z } from 'zod';

/**
 * The inbox object (§4 F2). An idea is raw capture — text, maybe a link,
 * maybe an image path — and never a canvas node: the inbox and the research
 * view render it, the graph reaches it only through a `derived_from` link
 * created when a spec proposal is adopted. `title` is derived (the first line
 * of `text`), never typed in; `tags` are classified by rule at capture time.
 */
export const IdeaIdSchema = z
  .string()
  .regex(/^I_[A-Za-z0-9_-]{8,24}$/, { message: 'idea id must start with I_' });
export type IdeaId = z.infer<typeof IdeaIdSchema>;

export const IDEA_STATES = ['captured', 'promoted', 'archived'] as const;
export const IdeaStateSchema = z.enum(IDEA_STATES);
export type IdeaState = z.infer<typeof IdeaStateSchema>;

/** The rule-based classification F2 asks for — order is the badge order. */
export const IDEA_TAGS = ['텍스트', '링크', '이미지'] as const;
export const IdeaTagSchema = z.enum(IDEA_TAGS);

export const IdeaSchema = z.object({
  id: IdeaIdSchema,
  title: z.string().min(1).max(200),
  text: z.string().min(1).max(8000),
  url: z.string().url().max(2048).optional(),
  imagePath: z.string().max(500).optional(),
  tags: z.array(IdeaTagSchema).max(8),
  state: IdeaStateSchema,
  capturedAt: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Idea = z.infer<typeof IdeaSchema>;
