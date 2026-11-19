import {
  PinSchema,
  ScreenSchema,
  type Command,
  type DomainEvent,
  type Anchor,
  type Doc,
  type Pin,
  type Project,
  type Proposal,
  type Screen,
} from '@spec-studio/protocol';
import {
  applyPatches,
  buildProposal,
  confirmRef,
  createDoc,
  findBlock,
  insertBlock,
  makeBlock,
  blockRefFor,
  moveBlock,
  syncBlockText,
  withBlocks,
} from './doc';
import { DomainError } from './errors';
import { filterPins, findPin, nextPinNumber, resolvePinSeq, sortPinsByNumber } from './pins';

export { DomainError, type DomainErrorCode } from './errors';

export interface ExecuteContext {
  /** Passed in, never read from the clock — core stays pure. */
  at: string;
  /** Ids are supplied by the caller for the same reason. */
  nextId: (kind: 'screen' | 'pin' | 'doc' | 'block' | 'proposal') => string;
}

export interface ExecutionResult {
  project: Project;
  events: DomainEvent[];
}

const round = (value: number, places = 4): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** A click or a drag both land in 0..1; anything else is a bug upstream. */
function requireAnchor(anchor: Anchor): Anchor {
  if (anchor.x < 0 || anchor.y > 1 || anchor.y < 0 || anchor.x > 1) {
    throw new DomainError('invalid_input', 'anchor must be inside the screen (0..1)');
  }
  return { x: round(clamp01(anchor.x)), y: round(clamp01(anchor.y)) };
}

export function createProject(input: { id: string; name: string; at: string }): Project {
  if (input.id.trim() === '') throw new DomainError('invalid_input', 'project id is required');
  const name = input.name.trim();
  if (name === '') throw new DomainError('invalid_input', 'project name is required');
  return {
    version: 1,
    id: input.id,
    name,
    screen: null,
    pins: [],
    pinSeq: 0,
    doc: null,
    proposal: null,
    createdAt: input.at,
    updatedAt: input.at,
  };
}

/**
 * Brings state from outside (local storage, an import, a database) back to the
 * invariants: pins ordered by number, and the high-water mark at least as high
 * as every number still present.
 */
export function normalizeProject(project: Project): Project {
  const pins = sortPinsByNumber(project.pins);
  const pinSeq = resolvePinSeq(project.pinSeq, project.pins);
  const alreadyOrdered = project.pins.every((pin, index) => pin.id === pins[index]?.id);
  if (alreadyOrdered && pinSeq === project.pinSeq) return project;
  return { ...project, pins, pinSeq };
}

export function pinsForScreen(project: Project, screenId: string): Pin[] {
  return project.pins.filter((pin) => pin.screenId === screenId);
}

function requireScreen(project: Project, screenId: string): Screen {
  const screen = project.screen;
  if (screen === null) throw new DomainError('screen_missing', 'attach a screen first');
  if (screen.id !== screenId) {
    throw new DomainError('screen_mismatch', 'the command targets a different screen');
  }
  return screen;
}

function requireDoc(project: Project, docId: string): Doc {
  if (project.doc === null) throw new DomainError('doc_missing', '문서가 아직 없습니다');
  if (project.doc.id !== docId) {
    throw new DomainError('doc_mismatch', 'the command targets a different document');
  }
  return project.doc;
}

function requireOpenProposal(project: Project, proposalId: string): Proposal {
  const proposal = project.proposal;
  if (proposal === null || proposal.id !== proposalId) {
    throw new DomainError('proposal_missing', '제안을 찾지 못했습니다');
  }
  if (proposal.state !== 'open') {
    throw new DomainError('proposal_decided', '이미 결정된 제안입니다');
  }
  return proposal;
}

/**
 * Applies one command. Every state change goes through here so the numbering
 * rule has exactly one implementation, and the UI can only inherit it.
 */
export function execute(
  project: Project,
  command: Command,
  ctx: ExecuteContext,
): ExecutionResult {
  switch (command.type) {
    case 'screen.attach': {
      const screen = command.screen;
      const differentScreen = project.screen !== null && project.screen.id !== screen.id;
      if (differentScreen) {
        // A new screen is a new numbering space; the previous pins stay with
        // the previous screen and are not renumbered into this one. Its
        // document is new too — the prose described that screen, not this one.
        const doc = createDoc({
          id: ctx.nextId('doc'),
          title: `${screen.title} 문서`,
          at: ctx.at,
        });
        return {
          project: {
            ...project,
            screen,
            pins: [],
            pinSeq: 0,
            doc,
            proposal: null,
            updatedAt: ctx.at,
          },
          events: [
            { type: 'screen.attached', screen },
            { type: 'doc.attached', doc },
          ],
        };
      }
      const doc =
        project.doc ??
        createDoc({ id: ctx.nextId('doc'), title: `${screen.title} 문서`, at: ctx.at });
      return {
        project: { ...project, screen, doc, updatedAt: ctx.at },
        events:
          project.doc === null
            ? [
                { type: 'screen.attached', screen },
                { type: 'doc.attached', doc },
              ]
            : [{ type: 'screen.attached', screen }],
      };
    }

    case 'screen.update': {
      const screen = requireScreen(project, command.screenId);
      const title = command.title === undefined ? screen.title : command.title.trim();
      if (title === '') throw new DomainError('invalid_input', 'a screen needs a title');
      const next = ScreenSchema.parse({
        ...screen,
        title,
        ...(command.figmaUrl === undefined ? {} : { figmaUrl: command.figmaUrl }),
        updatedAt: ctx.at,
      });
      return {
        project: { ...project, screen: next, updatedAt: ctx.at },
        events: [{ type: 'screen.updated', screen: next }],
      };
    }

    case 'pin.create': {
      const screen = requireScreen(project, command.screenId);
      const title = command.title.trim();
      if (title === '') throw new DomainError('invalid_input', 'a pin needs a title');
      const anchor = requireAnchor(command.anchor);
      const number = nextPinNumber(project.pinSeq);
      const pin = PinSchema.parse({
        id: ctx.nextId('pin'),
        screenId: screen.id,
        number,
        type: command.pinType,
        title,
        body: command.body.trim(),
        anchor,
        createdAt: ctx.at,
        updatedAt: ctx.at,
      });
      return {
        project: {
          ...project,
          pins: sortPinsByNumber([...project.pins, pin]),
          pinSeq: number,
          updatedAt: ctx.at,
        },
        events: [{ type: 'pin.created', pin }],
      };
    }

    case 'pin.update': {
      const screen = requireScreen(project, command.screenId);
      const current = findPin(project.pins, command.pinId);
      if (!current) throw new DomainError('pin_not_found', 'no pin with that id on this screen');
      if (current.screenId !== screen.id) {
        throw new DomainError('screen_mismatch', 'the pin belongs to another screen');
      }
      const title = command.title === undefined ? current.title : command.title.trim();
      if (title === '') throw new DomainError('invalid_input', 'a pin needs a title');
      const anchor =
        command.anchor === undefined ? current.anchor : requireAnchor(command.anchor);
      const pin = PinSchema.parse({
        ...current,
        type: command.pinType ?? current.type,
        title,
        body: command.body === undefined ? current.body : command.body.trim(),
        anchor,
        updatedAt: ctx.at,
      });
      return {
        project: {
          ...project,
          pins: project.pins.map((candidate) => (candidate.id === pin.id ? pin : candidate)),
          updatedAt: ctx.at,
        },
        events: [{ type: 'pin.updated', pin }],
      };
    }

    case 'pin.delete': {
      const screen = requireScreen(project, command.screenId);
      const current = findPin(project.pins, command.pinId);
      if (!current) throw new DomainError('pin_not_found', 'no pin with that id on this screen');
      return {
        project: {
          ...project,
          pins: project.pins.filter((pin) => pin.id !== current.id),
          updatedAt: ctx.at,
        },
        events: [
          { type: 'pin.deleted', screenId: screen.id, pinId: current.id, number: current.number },
        ],
      };
    }

    // ── document blocks ────────────────────────────────────────────────
    case 'doc.block.create': {
      const doc = requireDoc(project, command.docId);
      const block = makeBlock({
        id: ctx.nextId('block'),
        type: command.blockType,
        text: command.text,
        at: ctx.at,
      });
      // No `afterBlockId` means "at the end", which is what writing does.
      const after =
        command.afterBlockId === undefined
          ? (doc.blocks.at(-1)?.id ?? null)
          : command.afterBlockId;
      const blocks = insertBlock(doc, block, after);
      return {
        project: { ...project, doc: withBlocks(doc, blocks, ctx.at), updatedAt: ctx.at },
        events: [{ type: 'block.created', block }],
      };
    }

    case 'doc.block.update': {
      const doc = requireDoc(project, command.docId);
      if (command.text === undefined && command.blockType === undefined) {
        throw new DomainError('invalid_input', '바꿀 내용이 없습니다');
      }
      const current = findBlock(doc, command.blockId);
      if (current === undefined) throw new DomainError('block_not_found', '문단을 찾지 못했습니다');
      const block = {
        ...current,
        type: command.blockType ?? current.type,
        text: command.text ?? current.text,
        updatedAt: ctx.at,
      };
      const blocks = doc.blocks.map((candidate) =>
        candidate.id === block.id ? block : candidate,
      );
      return {
        project: { ...project, doc: withBlocks(doc, blocks, ctx.at), updatedAt: ctx.at },
        events: [{ type: 'block.updated', block }],
      };
    }

    case 'doc.block.delete': {
      const doc = requireDoc(project, command.docId);
      if (findBlock(doc, command.blockId) === undefined) {
        throw new DomainError('block_not_found', '문단을 찾지 못했습니다');
      }
      const blocks = doc.blocks.filter((block) => block.id !== command.blockId);
      return {
        project: { ...project, doc: withBlocks(doc, blocks, ctx.at), updatedAt: ctx.at },
        events: [{ type: 'block.deleted', docId: doc.id, blockId: command.blockId }],
      };
    }

    case 'doc.block.move': {
      const doc = requireDoc(project, command.docId);
      const blocks = moveBlock(doc, command.blockId, command.afterBlockId, ctx.at);
      return {
        project: { ...project, doc: withBlocks(doc, blocks, ctx.at), updatedAt: ctx.at },
        events: [
          {
            type: 'block.moved',
            docId: doc.id,
            blockId: command.blockId,
            afterBlockId: command.afterBlockId,
          },
        ],
      };
    }

    case 'doc.pin.link': {
      const doc = requireDoc(project, command.docId);
      const block = findBlock(doc, command.blockId);
      if (block === undefined) throw new DomainError('block_not_found', '문단을 찾지 못했습니다');
      const pin = findPin(project.pins, command.pinId);
      if (pin === undefined) throw new DomainError('pin_not_found', '핀을 찾지 못했습니다');
      if (block.pinRefs.some((ref) => ref.pinId === pin.id)) {
        throw new DomainError('invalid_input', `#${pin.number} 핀은 이미 이 문단에 연결되어 있습니다`);
      }
      const ref = blockRefFor(pin, ctx.at);
      const updated = {
        ...block,
        pinRefs: [...block.pinRefs, ref],
        text: syncBlockText(block.text, [...block.pinRefs, ref], project.pins),
        updatedAt: ctx.at,
      };
      return {
        project: {
          ...project,
          doc: withBlocks(
            doc,
            doc.blocks.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
            ctx.at,
          ),
          updatedAt: ctx.at,
        },
        events: [
          {
            type: 'block.pin.linked',
            docId: doc.id,
            blockId: updated.id,
            pinId: pin.id,
          },
        ],
      };
    }

    case 'doc.pin.unlink': {
      const doc = requireDoc(project, command.docId);
      const block = findBlock(doc, command.blockId);
      if (block === undefined) throw new DomainError('block_not_found', '문단을 찾지 못했습니다');
      const refs = block.pinRefs.filter((ref) => ref.pinId !== command.pinId);
      if (refs.length === block.pinRefs.length) {
        throw new DomainError('invalid_input', '이 문단에 연결되지 않은 핀입니다');
      }
      const updated = {
        ...block,
        pinRefs: refs,
        text: syncBlockText(block.text, refs, project.pins),
        updatedAt: ctx.at,
      };
      return {
        project: {
          ...project,
          doc: withBlocks(
            doc,
            doc.blocks.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
            ctx.at,
          ),
          updatedAt: ctx.at,
        },
        events: [
          {
            type: 'block.pin.unlinked',
            docId: doc.id,
            blockId: updated.id,
            pinId: command.pinId,
          },
        ],
      };
    }

    case 'doc.stale.clear': {
      const doc = requireDoc(project, command.docId);
      const block = findBlock(doc, command.blockId);
      if (block === undefined) throw new DomainError('block_not_found', '문단을 찾지 못했습니다');
      const ref = block.pinRefs.find((candidate) => candidate.pinId === command.pinId);
      if (ref === undefined) throw new DomainError('invalid_input', '이 문단에 연결되지 않은 핀입니다');
      const pin = findPin(project.pins, command.pinId);
      // A person says the sentence is still right: keep the pin, take its
      // current spec as the baseline. If the pin is gone there is nothing to
      // confirm, so the citation goes.
      const refs =
        pin === undefined
          ? block.pinRefs.filter((candidate) => candidate.pinId !== command.pinId)
          : block.pinRefs.map((candidate) =>
              candidate.pinId === command.pinId ? confirmRef(candidate, pin, ctx.at) : candidate,
            );
      const updated = {
        ...block,
        pinRefs: refs,
        text: syncBlockText(block.text, refs, project.pins),
        updatedAt: ctx.at,
      };
      return {
        project: {
          ...project,
          doc: withBlocks(
            doc,
            doc.blocks.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
            ctx.at,
          ),
          updatedAt: ctx.at,
        },
        events: [
          {
            type: 'block.stale.cleared',
            docId: doc.id,
            blockId: updated.id,
            pinId: command.pinId,
          },
        ],
      };
    }

    // ── proposal layer ─────────────────────────────────────────────────
    case 'proposal.create': {
      const doc = requireDoc(project, command.docId);
      const proposal = buildProposal({
        id: ctx.nextId('proposal'),
        doc,
        pins: project.pins,
        at: ctx.at,
      });
      return {
        project: { ...project, proposal, updatedAt: ctx.at },
        events: [{ type: 'proposal.created', proposal }],
      };
    }

    case 'proposal.adopt': {
      const doc = requireDoc(project, command.docId);
      const proposal = requireOpenProposal(project, command.proposalId);
      if (proposal.docId !== doc.id) {
        throw new DomainError('doc_mismatch', '이 제안은 다른 문서의 것입니다');
      }
      const applied = applyPatches(doc, proposal.patches, ctx.at);
      const decided: Proposal = { ...proposal, state: 'adopted', decidedAt: ctx.at };
      return {
        project: {
          ...project,
          doc: applied.doc,
          proposal: decided,
          updatedAt: ctx.at,
        },
        events: [
          {
            type: 'proposal.adopted',
            docId: doc.id,
            proposalId: proposal.id,
            summary: proposal.summary,
          },
        ],
      };
    }

    case 'proposal.reject': {
      const doc = requireDoc(project, command.docId);
      const proposal = requireOpenProposal(project, command.proposalId);
      const decided: Proposal = { ...proposal, state: 'rejected', decidedAt: ctx.at };
      return {
        project: { ...project, proposal: decided, updatedAt: ctx.at },
        events: [
          { type: 'proposal.rejected', docId: doc.id, proposalId: proposal.id },
        ],
      };
    }

    default: {
      const exhaustive: never = command;
      throw new DomainError('invalid_input', `unknown command ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Convenience for list views: pins of the screen, optionally filtered by type. */
export function visiblePins(project: Project, filter: Parameters<typeof filterPins>[1] = 'all'): Pin[] {
  return filterPins(project.pins, filter);
}
