import {
  AiDocDraftSchema,
  AiGraphDraftSchema,
  type AiDocDraft,
  type AiGraphDraft,
} from '@spec-studio/protocol';

/**
 * The answer, or nothing.
 *
 * A model asked for JSON still says "Sure — here is the JSON:" now and then,
 * so fences and prose are peeled off before parsing. What is parsed is then
 * held to the protocol schema exactly: an unknown node type, a link without a
 * named type, a block id that is not an id, or a 25th node all fail here, where
 * the failure costs a retry, instead of in the store, where it would cost a
 * half-written decision.
 */

export class AiDraftError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'AiDraftError';
    this.issues = issues;
  }
}

/** The first JSON object in the text, fences and prose removed. */
export function extractJsonObject(text: string): unknown {
  let body = text.replace(/^\uFEFF/, '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(body);
  if (fence !== null && fence[1] !== undefined && fence[1].trim() !== '') {
    body = fence[1].trim();
  }
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new AiDraftError('모델 응답에서 JSON을 찾지 못했습니다.');
  }
  const slice = body.slice(start, end + 1);
  try {
    return JSON.parse(slice) as unknown;
  } catch {
    throw new AiDraftError('모델 응답이 올바른 JSON이 아닙니다.');
  }
}

function issuesOf(error: unknown): string[] {
  const issues = (error as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues;
  if (!Array.isArray(issues)) return [];
  return issues.slice(0, 6).map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

export function parseGraphDraft(text: string): AiGraphDraft {
  const parsed = AiGraphDraftSchema.safeParse(extractJsonObject(text));
  if (!parsed.success) {
    const issues = issuesOf(parsed.error);
    throw new AiDraftError(`모델 응답이 초안 스키마와 맞지 않습니다. ${issues.join(' / ')}`, issues);
  }
  return parsed.data;
}

export function parseDocDraft(text: string): AiDocDraft {
  const parsed = AiDocDraftSchema.safeParse(extractJsonObject(text));
  if (!parsed.success) {
    const issues = issuesOf(parsed.error);
    throw new AiDraftError(`모델 응답이 초안 스키마와 맞지 않습니다. ${issues.join(' / ')}`, issues);
  }
  return parsed.data;
}
