import {
  EvidenceSchema,
  IdeaSchema,
  NODE_TYPE_KIND,
  linkKindEndsAllow,
  type Command,
  type DomainEvent,
  type Evidence,
  type GraphLinkType,
  type Idea,
  type ObjectKind,
  type Project,
} from '@spec-studio/protocol';
import { DomainError } from './errors';

/**
 * The inbox and the research board's pure half (E1 §4 F2·F3). Capture is a
 * classifier, not a form: the title is the first line of the text, the tags
 * say what the capture carries, and the state machine is two exits from
 * `captured` — nothing comes back.
 */

/** F2: 제목은 원문의 첫 줄 — typed in by nobody, re-derived on every edit. */
export function ideaTitleOf(text: string): string {
  const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? '';
  return firstLine.slice(0, 200);
}

/** F2's rule-based classification: what the capture carries, in badge order. */
export function ideaTagsOf(input: {
  text: string;
  url?: string | undefined;
  imagePath?: string | undefined;
}): Idea['tags'] {
  const tags: Idea['tags'] = ['텍스트'];
  if (input.url !== undefined || /https?:\/\//.test(input.text)) tags.push('링크');
  if (input.imagePath !== undefined) tags.push('이미지');
  return tags;
}

export function findIdea(project: Project, ideaId: string): Idea | undefined {
  return project.ideas.find((idea) => idea.id === ideaId);
}

export function requireIdea(project: Project, ideaId: string): Idea {
  const idea = findIdea(project, ideaId);
  if (idea === undefined) throw new DomainError('invalid_input', '그 아이디어를 찾지 못했습니다');
  return idea;
}

export function findEvidence(project: Project, evidenceId: string): Evidence | undefined {
  return project.evidence.find((evidence) => evidence.id === evidenceId);
}

export function requireEvidence(project: Project, evidenceId: string): Evidence {
  const evidence = findEvidence(project, evidenceId);
  if (evidence === undefined) throw new DomainError('invalid_input', '그 근거를 찾지 못했습니다');
  return evidence;
}

/**
 * The obj-kind resolver `link.create` validates against (A1): screens, then
 * pins, then the graph's editable nodes via NODE_TYPE_KIND, then the inbox
 * and the evidence board. `null` means "not in this project".
 */
export function objectKindOf(project: Project, id: string): ObjectKind | null {
  if (project.screen !== null && project.screen.id === id) return 'screen';
  if (project.pins.some((pin) => pin.id === id)) return 'pin';
  const node = project.graph.nodes.find((candidate) => candidate.id === id);
  if (node !== undefined) return NODE_TYPE_KIND[node.type].kind;
  if (project.ideas.some((idea) => idea.id === id)) return 'idea';
  if (project.evidence.some((evidence) => evidence.id === id)) return 'evidence';
  return null;
}

export function linkKindAllowed(
  project: Project,
  linkType: GraphLinkType,
  src: string,
  dst: string,
): boolean {
  return linkKindEndsAllow(linkType, objectKindOf(project, src), objectKindOf(project, dst));
}

/** A title for an evidence row when the capture did not name one. */
export function evidenceTitleOf(url: string, excerpt: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.hostname}${path}`.slice(0, 200);
  } catch {
    return excerpt.trim().split(/\r?\n/, 1)[0]!.slice(0, 200) || url.slice(0, 200);
  }
}

// ── the command bodies, pure: state in, state + events out ───────────────

type InboxCommand = Extract<
  Command,
  { type: 'idea.capture' | 'idea.update' | 'idea.archive' | 'evidence.capture' | 'evidence.update' | 'evidence.dismiss' }
>;

/**
 * F3-3: a `references` link naming an evidence row cites it. Only `captured`
 * rows move — a dismissed row was already judged, and `cited` is terminal
 * anyway. Returns the same project when nothing changed.
 */
export function markEvidenceCited(
  project: Project,
  evidenceIds: readonly string[],
  at: string,
): Project {
  const ids = new Set(evidenceIds);
  let changed = false;
  const evidence = project.evidence.map((row) => {
    if (!ids.has(row.id) || row.state !== 'captured') return row;
    changed = true;
    return { ...row, state: 'cited' as const, updatedAt: at };
  });
  return changed ? { ...project, evidence } : project;
}

export function executeInbox(
  project: Project,
  command: InboxCommand,
  ctx: { at: string; nextId: (kind: 'idea' | 'evidence') => string },
): { project: Project; events: DomainEvent[] } {
  switch (command.type) {
    case 'idea.capture': {
      const idea = IdeaSchema.parse({
        id: ctx.nextId('idea'),
        title: ideaTitleOf(command.text),
        text: command.text,
        ...(command.url === undefined ? {} : { url: command.url }),
        ...(command.image === undefined ? {} : { imagePath: command.image }),
        tags: ideaTagsOf({ text: command.text, url: command.url, imagePath: command.image }),
        state: 'captured',
        capturedAt: ctx.at,
        createdAt: ctx.at,
        updatedAt: ctx.at,
      });
      return {
        project: { ...project, ideas: [...project.ideas, idea], updatedAt: ctx.at },
        events: [{ type: 'idea.captured', idea }],
      };
    }

    case 'idea.update':
    case 'idea.archive': {
      const current = requireIdea(project, command.ideaId);
      const nextState = command.type === 'idea.archive' ? 'archived' : (command.state ?? current.state);
      if (nextState !== current.state) {
        const allowed: Record<Idea['state'], Idea['state'][]> = {
          captured: ['promoted', 'archived'],
          promoted: [],
          archived: [],
        };
        if (!allowed[current.state].includes(nextState)) {
          throw new DomainError(
            'invalid_input',
            `아이디어 상태는 ${current.state}에서 ${nextState}(으)로 바꿀 수 없습니다`,
          );
        }
      }
      const text = command.type === 'idea.archive' ? current.text : (command.text ?? current.text);
      const url = command.type === 'idea.archive' ? current.url : (command.url ?? current.url);
      const imagePath =
        command.type === 'idea.archive' ? current.imagePath : (command.image ?? current.imagePath);
      const idea = IdeaSchema.parse({
        ...current,
        title: ideaTitleOf(text),
        text,
        ...(url === undefined ? {} : { url }),
        ...(imagePath === undefined ? {} : { imagePath: imagePath }),
        tags: ideaTagsOf({ text, url, imagePath }),
        state: nextState,
        updatedAt: ctx.at,
      });
      return {
        project: {
          ...project,
          ideas: project.ideas.map((candidate) => (candidate.id === idea.id ? idea : candidate)),
          updatedAt: ctx.at,
        },
        events:
          command.type === 'idea.archive'
            ? [{ type: 'idea.archived', idea }]
            : [{ type: 'idea.updated', idea }],
      };
    }

    case 'evidence.capture': {
      const evidence = EvidenceSchema.parse({
        id: ctx.nextId('evidence'),
        title: command.title ?? evidenceTitleOf(command.url, command.excerpt),
        url: command.url,
        excerpt: command.excerpt,
        type: command.evidenceType,
        state: 'captured',
        capturedAt: ctx.at,
        createdAt: ctx.at,
        updatedAt: ctx.at,
      });
      return {
        project: { ...project, evidence: [...project.evidence, evidence], updatedAt: ctx.at },
        events: [{ type: 'evidence.captured', evidence }],
      };
    }

    case 'evidence.update': {
      const current = requireEvidence(project, command.evidenceId);
      const evidence = EvidenceSchema.parse({
        ...current,
        title: command.title ?? current.title,
        excerpt: command.excerpt ?? current.excerpt,
        url: command.url ?? current.url,
        updatedAt: ctx.at,
      });
      return {
        project: {
          ...project,
          evidence: project.evidence.map((candidate) =>
            candidate.id === evidence.id ? evidence : candidate,
          ),
          updatedAt: ctx.at,
        },
        events: [{ type: 'evidence.updated', evidence }],
      };
    }

    case 'evidence.dismiss': {
      const current = requireEvidence(project, command.evidenceId);
      if (current.state === 'dismissed') {
        throw new DomainError('invalid_input', '이미 기각된 근거입니다');
      }
      const evidence: Evidence = { ...current, state: 'dismissed', updatedAt: ctx.at };
      return {
        project: {
          ...project,
          evidence: project.evidence.map((candidate) =>
            candidate.id === evidence.id ? evidence : candidate,
          ),
          updatedAt: ctx.at,
        },
        events: [{ type: 'evidence.dismissed', evidence }],
      };
    }
  }
}
