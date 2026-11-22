import {
  AiBriefDraftSchema,
  type AiBriefDraft,
  type Project,
  type Project as ProjectType,
} from '@spec-studio/protocol';

/**
 * The brief engine's rule half (E1 §4 F3-2). The daemon's local plan and the
 * eval gate call the same function, so the number the badge shows and the
 * number `pnpm eval` defends are produced by one implementation.
 */

export interface BriefInput {
  /** The idea the brief is about; falls back to the newest one when absent. */
  ideaId?: string | null;
  /** 주제 텍스트 when no idea is picked. */
  topic?: string | null;
  /** The evidence to cite; absent means everything on the board. */
  evidenceIds?: readonly string[] | null;
}

/** The fallback never drafts more than this many evidence claims (schema: 12 claims). */
export const BRIEF_MAX_EVIDENCE = 10;

export function selectedEvidence(project: ProjectType, input: BriefInput): Project['evidence'] {
  if (input.evidenceIds === undefined || input.evidenceIds === null) {
    return project.evidence.slice(0, BRIEF_MAX_EVIDENCE);
  }
  const byId = new Map(project.evidence.map((row) => [row.id, row] as const));
  const picked: Project['evidence'] = [];
  for (const id of input.evidenceIds) {
    const row = byId.get(id);
    if (row === undefined || picked.includes(row)) continue;
    picked.push(row);
    if (picked.length >= BRIEF_MAX_EVIDENCE) break;
  }
  return picked;
}

/**
 * The deterministic template (문제·근거·기회·다음 질문): one claim per selected
 * evidence, then the two claims no evidence can back — 기회 and 다음 질문 —
 * marked `ungrounded` so the card says so instead of dressing them up.
 */
export function buildFallbackBrief(project: Project, input: BriefInput): AiBriefDraft {
  const idea =
    input.ideaId !== undefined && input.ideaId !== null
      ? (project.ideas.find((row) => row.id === input.ideaId) ?? null)
      : input.topic === undefined || input.topic === null || input.topic.trim() === ''
        ? (project.ideas.at(-1) ?? null)
        : null;
  const subject = (idea?.title ?? input.topic?.trim().split(/\r?\n/, 1)[0] ?? '').slice(0, 120);
  const title = subject === '' ? '리서치 브리프' : subject;
  const firstLine =
    idea === null
      ? (input.topic?.trim() ?? '')
      : (idea.text.trim().split(/\r?\n/, 1)[0] ?? '');
  const summary =
    firstLine === '' ? `${title}에 대한 브리프입니다.` : firstLine.slice(0, 300);

  const claims: AiBriefDraft['claims'] = selectedEvidence(project, input).map((row) => ({
    text: row.title.slice(0, 800),
    evidenceRefs: [row.id],
    sourceUrls: [],
    ungrounded: false,
  }));
  claims.push({
    text: `기회: ${title}에서 증거 없이 가정한 기회이다.`.slice(0, 800),
    evidenceRefs: [],
    sourceUrls: [],
    ungrounded: true,
  });
  claims.push({
    text: `다음 질문: ${title}에서 다음에 확인해야 할 질문이다.`.slice(0, 800),
    evidenceRefs: [],
    sourceUrls: [],
    ungrounded: true,
  });

  return AiBriefDraftSchema.parse({ title, summary, claims });
}
