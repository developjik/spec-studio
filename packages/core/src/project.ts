import {
  PinSchema,
  ScreenSchema,
  type Command,
  type DomainEvent,
  type Anchor,
  type Doc,
  type EditableNodeType,
  type GraphLink,
  type GraphNode,
  type Pin,
  type Project,
  type Proposal,
  type Screen,
} from '@spec-studio/protocol';
import {
  applyPatches,
  proposalIsStale,
  buildProposal,
  buildProposalFromBrief,
  buildProposalFromDraft,
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
import {
  buildGraphProposalFromDraft,
  extractGraphProposal,
  makeGraphNode,
  markLinksSuspect,
  nodeStateOptions,
  normalizeGraph,
  resolveProposalRef,
} from './graph';
import { executeInbox, linkKindAllowed, markEvidenceCited, objectKindOf } from './ideas';
import { filterPins, findPin, nextPinNumber, resolvePinSeq, sortPinsByNumber } from './pins';

export { DomainError, type DomainErrorCode } from './errors';

export type IdKind =
  | 'project'
  | 'screen'
  | 'pin'
  | 'doc'
  | 'block'
  | 'proposal'
  | 'node'
  | 'link'
  | 'graphProposal'
  | 'idea'
  | 'evidence';

export interface ExecuteContext {
  /** Passed in, never read from the clock — core stays pure. */
  at: string;
  /**
   * Ids are supplied by the caller for the same reason. A graph node carries
   * its type because the id prefix has to match the `obj` kind it becomes.
   */
  nextId: (kind: IdKind, nodeType?: EditableNodeType) => string;
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
    docs: [],
    proposals: [],
    ideas: [],
    evidence: [],
    graph: { nodes: [], links: [] },
    graphProposal: null,
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
  const graph = normalizeGraph(project);
  const alreadyOrdered = project.pins.every((pin, index) => pin.id === pins[index]?.id);
  if (alreadyOrdered && pinSeq === project.pinSeq && graph === project.graph) return project;
  return { ...project, pins, pinSeq, graph };
}

/** A node of the editable four kinds, by id. */
export function findGraphNode(project: Project, nodeId: string): GraphNode | undefined {
  return project.graph.nodes.find((node) => node.id === nodeId);
}

function requireGraphNode(project: Project, nodeId: string): GraphNode {
  const node = findGraphNode(project, nodeId);
  if (node === undefined) throw new DomainError('node_not_found', '그래프에서 그 객체를 찾지 못했습니다');
  return node;
}

// `objectKindOf` (./ideas) is the endpoint resolver `link.create` validates
// against; the canvas-type view of the same question is `graphTypeOfId`
// (./graph).

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

/**
 * The registry lookup every doc command starts from. There is one registry, so
 * "another document" and "no such document" are the same failure.
 */
function requireDoc(project: Project, docId: string): Doc {
  const doc = project.docs.find((candidate) => candidate.id === docId);
  if (doc === undefined) throw new DomainError('doc_missing', `문서가 없습니다: ${docId}`);
  return doc;
}

function requireOpenProposal(project: Project, proposalId: string): Proposal {
  const proposal = project.proposals.find((candidate) => candidate.id === proposalId);
  if (proposal === undefined) {
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
      const carried = differentScreen
        ? // A new screen is a new numbering space: the previous pins stay with
          // the previous screen and are not renumbered into this one, and
          // proposals built on those pins leave the table. The document
          // registry survives — its docs never belonged to one screen only.
          { ...project, screen, pins: [], pinSeq: 0, proposals: [] }
        : { ...project, screen };
      // A screen only brings its own auto-doc when the registry is empty; the
      // v1 flow (attach → a document exists) still holds.
      if (project.docs.length > 0) {
        return {
          project: { ...carried, updatedAt: ctx.at },
          events: [{ type: 'screen.attached', screen }],
        };
      }
      const doc = createDoc({ id: ctx.nextId('doc'), title: `${screen.title} 문서`, at: ctx.at });
      return {
        project: { ...carried, docs: [...project.docs, doc], updatedAt: ctx.at },
        events: [
          { type: 'screen.attached', screen },
          { type: 'doc.attached', doc },
        ],
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
      const moved = pin.type !== current.type || pin.title !== current.title || pin.body !== current.body;
      return {
        project: {
          ...project,
          pins: project.pins.map((candidate) => (candidate.id === pin.id ? pin : candidate)),
          // A link that still names this pin now names a different sentence;
          // the edge stays and asks for a re-read instead of disappearing.
          graph: moved
            ? { ...project.graph, links: markLinksSuspect(project.graph.links, pin.id, 'pin-changed', ctx.at) }
            : project.graph,
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

    // ── idea inbox · research board (E1 §4 F2·F3) ─────────────────────
    case 'idea.capture':
    case 'idea.update':
    case 'idea.archive':
    case 'evidence.capture':
    case 'evidence.update':
    case 'evidence.dismiss':
      return executeInbox(project, command, ctx);

    // ── document registry (W3/F5) ──────────────────────────────────────
    case 'doc.create': {
      const doc = createDoc({
        id: ctx.nextId('doc'),
        title: command.title,
        kind: command.kind,
        at: ctx.at,
      });
      return {
        project: { ...project, docs: [...project.docs, doc], updatedAt: ctx.at },
        events: [{ type: 'doc.created', doc }],
      };
    }

    case 'doc.update': {
      const doc = requireDoc(project, command.docId);
      const title = command.title.trim();
      if (title === '') throw new DomainError('invalid_input', '문서에는 제목이 필요합니다');
      const next: Doc = { ...doc, title, updatedAt: ctx.at };
      return {
        project: {
          ...project,
          docs: project.docs.map((candidate) => (candidate.id === doc.id ? next : candidate)),
          updatedAt: ctx.at,
        },
        events: [{ type: 'doc.renamed', docId: doc.id, title }],
      };
    }

    case 'doc.delete': {
      const doc = requireDoc(project, command.docId);
      // A proposal still on the table for this doc cannot outlive it; the
      // decision is recorded the same way a refusal records it.
      const proposals = project.proposals.map((candidate) =>
        candidate.docId === doc.id && candidate.state === 'open'
          ? { ...candidate, state: 'rejected' as const, decidedAt: ctx.at }
          : candidate,
      );
      return {
        project: {
          ...project,
          docs: project.docs.filter((candidate) => candidate.id !== doc.id),
          proposals,
          updatedAt: ctx.at,
        },
        events: [{ type: 'doc.deleted', docId: doc.id }],
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
        project: {
          ...project,
          docs: project.docs.map((candidate) =>
            candidate.id === doc.id ? withBlocks(doc, blocks, ctx.at) : candidate,
          ),
          updatedAt: ctx.at,
        },
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
        project: {
          ...project,
          docs: project.docs.map((candidate) =>
            candidate.id === doc.id ? withBlocks(doc, blocks, ctx.at) : candidate,
          ),
          updatedAt: ctx.at,
        },
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
        project: {
          ...project,
          docs: project.docs.map((candidate) =>
            candidate.id === doc.id ? withBlocks(doc, blocks, ctx.at) : candidate,
          ),
          updatedAt: ctx.at,
        },
        events: [{ type: 'block.deleted', docId: doc.id, blockId: command.blockId }],
      };
    }

    case 'doc.block.move': {
      const doc = requireDoc(project, command.docId);
      const blocks = moveBlock(doc, command.blockId, command.afterBlockId, ctx.at);
      return {
        project: {
          ...project,
          docs: project.docs.map((candidate) =>
            candidate.id === doc.id ? withBlocks(doc, blocks, ctx.at) : candidate,
          ),
          updatedAt: ctx.at,
        },
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
          docs: project.docs.map((candidate) =>
            candidate.id === doc.id
              ? withBlocks(
                  doc,
                  doc.blocks.map((entry) => (entry.id === updated.id ? updated : entry)),
                  ctx.at,
                )
              : candidate,
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
          docs: project.docs.map((candidate) =>
            candidate.id === doc.id
              ? withBlocks(
                  doc,
                  doc.blocks.map((entry) => (entry.id === updated.id ? updated : entry)),
                  ctx.at,
                )
              : candidate,
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
          docs: project.docs.map((candidate) =>
            candidate.id === doc.id
              ? withBlocks(
                  doc,
                  doc.blocks.map((entry) => (entry.id === updated.id ? updated : entry)),
                  ctx.at,
                )
              : candidate,
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
      const proposal =
        command.draft === undefined
          ? buildProposal({
              id: ctx.nextId('proposal'),
              doc,
              pins: project.pins,
              at: ctx.at,
            })
          : 'claims' in command.draft
            ? // A brief (F3-2) becomes insert patches: heading, summary, one
              // paragraph per claim. The trust boundary stays here — an id
              // the evidence board does not have is rejected before 채택.
              buildProposalFromBrief({
                id: ctx.nextId('proposal'),
                doc,
                evidence: project.evidence,
                draft: command.draft,
                at: ctx.at,
              })
            : buildProposalFromDraft({
                id: ctx.nextId('proposal'),
                doc,
                pins: project.pins,
                draft: command.draft,
                at: ctx.at,
              });
      const queued: Proposal = { ...proposal, queuedAt: ctx.at, queueOrder: Math.max(0, ...project.proposals.map(p => p.queueOrder ?? 0)) + 1, source: command.source ?? (command.draft === undefined ? 'rule' : 'llm') };
      return {
        project: { ...project, proposals: [...project.proposals, queued], updatedAt: ctx.at },
        events: [{ type: 'proposal.created', proposal: queued }],
      };
    }

    case 'proposal.defer': {
      const doc = requireDoc(project, command.docId);
      const proposal = requireOpenProposal(project, command.proposalId);
      if (proposal.docId !== doc.id) throw new DomainError('doc_missing', '이 제안은 다른 문서의 것입니다');
      const next = { ...proposal, queuedAt: ctx.at, queueOrder: Math.max(0, ...project.proposals.map(p => p.queueOrder ?? 0)) + 1 };
      return {
        project: { ...project, proposals: project.proposals.map(p => p.id === proposal.id ? next : p), updatedAt: ctx.at },
        events: [{ type: 'proposal.deferred', docId: doc.id, proposalId: proposal.id }],
      };
    }

    case 'proposal.adopt': {
      const doc = requireDoc(project, command.docId);
      const proposal = requireOpenProposal(project, command.proposalId);
      if (proposal.docId !== doc.id) {
        // One registry: a proposal naming another doc is the same failure as
        // naming none.
        throw new DomainError('doc_missing', '이 제안은 다른 문서의 것입니다');
      }
      if (proposalIsStale(doc, proposal, project.pins)) {
        throw new DomainError('invalid_input', '제안 이후 문단이나 참조 핀이 변경됐습니다. 새 제안을 만들어 비교하세요');
      }
      const applied = applyPatches(doc, proposal.patches, ctx.at);
      const decided: Proposal = { ...proposal, state: 'adopted', decidedAt: ctx.at };
      return {
        project: {
          ...project,
          docs: project.docs.map((candidate) =>
            candidate.id === doc.id ? applied.doc : candidate,
          ),
          proposals: project.proposals.map((candidate) =>
            candidate.id === proposal.id ? decided : candidate,
          ),
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
      if (proposal.docId !== doc.id) throw new DomainError('doc_missing', '이 제안은 다른 문서의 것입니다');
      const decided: Proposal = { ...proposal, state: 'rejected', decidedAt: ctx.at };
      return {
        project: {
          ...project,
          proposals: project.proposals.map((candidate) =>
            candidate.id === proposal.id ? decided : candidate,
          ),
          updatedAt: ctx.at,
        },
        events: [
          { type: 'proposal.rejected', docId: doc.id, proposalId: proposal.id },
        ],
      };
    }

    // ── object graph ───────────────────────────────────────────────────
    case 'node.create': {
      const id = ctx.nextId('node', command.nodeType);
      const node = makeGraphNode({
        id,
        type: command.nodeType,
        title: command.title,
        body: command.body,
        at: ctx.at,
      });
      return {
        project: {
          ...project,
          graph: { ...project.graph, nodes: [...project.graph.nodes, node] },
          updatedAt: ctx.at,
        },
        events: [{ type: 'node.created', node }],
      };
    }

    case 'node.update': {
      const current = requireGraphNode(project, command.nodeId);
      const title = command.title === undefined ? current.title : command.title.trim();
      if (title === '') throw new DomainError('invalid_input', '객체에는 제목이 필요합니다');
      const state = command.state ?? current.state;
      const states = nodeStateOptions(current.type);
      if (!states.includes(state)) {
        throw new DomainError('invalid_input', `${current.type} 상태는 ${states.join(' · ')} 중 하나입니다`);
      }
      const node: GraphNode = {
        ...current,
        title,
        body: command.body === undefined ? current.body : command.body.trim(),
        state,
        updatedAt: ctx.at,
      };
      const moved = node.title !== current.title || node.body !== current.body;
      return {
        project: {
          ...project,
          graph: {
            ...project.graph,
            nodes: project.graph.nodes.map((candidate) =>
              candidate.id === node.id ? node : candidate,
            ),
            links: moved
              ? markLinksSuspect(project.graph.links, node.id, 'node-changed', ctx.at)
              : project.graph.links,
          },
          updatedAt: ctx.at,
        },
        events: [{ type: 'node.updated', node }],
      };
    }

    case 'node.delete': {
      requireGraphNode(project, command.nodeId);
      return {
        project: {
          ...project,
          graph: {
            nodes: project.graph.nodes.filter((node) => node.id !== command.nodeId),
            links: project.graph.links.filter(
              (link) => link.src !== command.nodeId && link.dst !== command.nodeId,
            ),
          },
          updatedAt: ctx.at,
        },
        events: [{ type: 'node.deleted', nodeId: command.nodeId }],
      };
    }

    case 'link.create': {
      // A1: validation runs at `obj`-kind level against the same registry
      // rows the store's triggers hold, so an idea or an evidence row can be
      // an endpoint without becoming a canvas node type.
      const srcKind = objectKindOf(project, command.src);
      const dstKind = objectKindOf(project, command.dst);
      if (srcKind === null || dstKind === null) {
        throw new DomainError('node_not_found', '링크의 한쪽 객체를 찾지 못했습니다');
      }
      if (command.src === command.dst) {
        throw new DomainError('invalid_input', '같은 객체로는 링크할 수 없습니다');
      }
      if (!linkKindAllowed(project, command.linkType, command.src, command.dst)) {
        throw new DomainError(
          'invalid_input',
          `${command.linkType} 링크는 ${srcKind} → ${dstKind} 를 연결할 수 없습니다`,
        );
      }
      const exists = project.graph.links.some(
        (link) =>
          link.type === command.linkType && link.src === command.src && link.dst === command.dst,
      );
      if (exists) throw new DomainError('invalid_input', '같은 링크가 이미 있습니다');
      const link: GraphLink = {
        id: ctx.nextId('link'),
        type: command.linkType,
        src: command.src,
        dst: command.dst,
        suspectSince: null,
        suspectWhy: null,
        createdAt: ctx.at,
      };
      // F3-3: citing evidence is what moves it to `cited` — the link and the
      // state change are one write. A dismissed row stays dismissed.
      const cited =
        command.linkType === 'references' && dstKind === 'evidence'
          ? markEvidenceCited(project, [command.dst], ctx.at)
          : project;
      const events: DomainEvent[] = [{ type: 'link.created', link }];
      const citedRow =
        cited.evidence === project.evidence
          ? null
          : (cited.evidence.find((row) => row.id === command.dst && row.updatedAt === ctx.at) ??
            null);
      if (citedRow !== null) events.push({ type: 'evidence.updated', evidence: citedRow });
      return {
        project: {
          ...cited,
          graph: { ...project.graph, links: [...project.graph.links, link] },
          updatedAt: ctx.at,
        },
        events,
      };
    }

    case 'link.delete': {
      if (!project.graph.links.some((link) => link.id === command.linkId)) {
        throw new DomainError('invalid_input', '그 링크를 찾지 못했습니다');
      }
      return {
        project: {
          ...project,
          graph: {
            ...project.graph,
            links: project.graph.links.filter((link) => link.id !== command.linkId),
          },
          updatedAt: ctx.at,
        },
        events: [{ type: 'link.deleted', linkId: command.linkId }],
      };
    }

    case 'link.ack': {
      const link = project.graph.links.find((candidate) => candidate.id === command.linkId);
      if (link === undefined) throw new DomainError('invalid_input', '그 링크를 찾지 못했습니다');
      return {
        project: {
          ...project,
          graph: {
            ...project.graph,
            links: project.graph.links.map((candidate) =>
              candidate.id === link.id
                ? { ...candidate, suspectSince: null, suspectWhy: null }
                : candidate,
            ),
          },
          updatedAt: ctx.at,
        },
        events: [{ type: 'link.acked', linkId: link.id }],
      };
    }

    case 'graph.proposal.create': {
      const proposal =
        command.draft === undefined
          ? extractGraphProposal(project, {
              id: ctx.nextId('graphProposal'),
              at: ctx.at,
            })
          : buildGraphProposalFromDraft(project, command.draft, {
              id: ctx.nextId('graphProposal'),
              at: ctx.at,
              source: command.source ?? 'llm',
              provider: command.provider ?? null,
              model: command.model ?? null,
            });
      return {
        project: { ...project, graphProposal: proposal, updatedAt: ctx.at },
        events: [{ type: 'graph.proposal.created', proposal }],
      };
    }

    case 'graph.proposal.adopt': {
      const proposal = project.graphProposal;
      if (proposal === null || proposal.id !== command.proposalId) {
        throw new DomainError('proposal_missing', '제안을 찾지 못했습니다');
      }
      if (proposal.state !== 'open') {
        throw new DomainError('proposal_decided', '이미 결정된 제안입니다');
      }
      if (proposal.nodes.length === 0) {
        throw new DomainError('invalid_input', '추출된 초안이 없습니다');
      }
      const created = new Map<string, string>();
      const nodes: GraphNode[] = [...project.graph.nodes];
      for (const draft of proposal.nodes) {
        const id = ctx.nextId('node', draft.type);
        created.set(draft.key, id);
        nodes.push(
          makeGraphNode({ id, type: draft.type, title: draft.title, body: draft.body, at: ctx.at }),
        );
      }
      // An idea ref only counts when the inbox still has it; the whole adopt
      // fails rather than half-landing, the same all-or-nothing an unknown
      // pin or node ref already gets.
      const ideaIds = new Set(project.ideas.map((idea) => idea.id));
      const links: GraphLink[] = [...project.graph.links];
      for (const draft of proposal.links) {
        const src = resolveProposalRef(draft.src, created, ideaIds);
        const dst = resolveProposalRef(draft.dst, created, ideaIds);
        if (src === null || dst === null) {
          throw new DomainError('invalid_input', '제안 링크의 대상을 풀지 못했습니다');
        }
        links.push({
          id: ctx.nextId('link'),
          type: draft.type,
          src,
          dst,
          suspectSince: null,
          suspectWhy: null,
          createdAt: ctx.at,
        });
      }
      // Evidence the adopted card cites becomes `cited`, the same write it
      // would get from a hand-made `references` link.
      const citedIds = links
        .filter((link) => link.createdAt === ctx.at && link.type === 'references')
        .map((link) => link.dst);
      const cited = markEvidenceCited(project, citedIds, ctx.at);
      const citedEvents: DomainEvent[] = cited.evidence
        .filter((row) => row.updatedAt === ctx.at && row.state === 'cited')
        .map((row) => ({ type: 'evidence.updated' as const, evidence: row }));
      const decided = { ...proposal, state: 'adopted' as const, decidedAt: ctx.at };
      return {
        project: {
          ...cited,
          graph: { nodes, links },
          graphProposal: decided,
          updatedAt: ctx.at,
        },
        events: [
          {
            type: 'graph.proposal.adopted',
            proposalId: proposal.id,
            nodes: proposal.nodes.length,
            links: proposal.links.length,
          },
          ...citedEvents,
        ],
      };
    }

    case 'graph.proposal.reject': {
      const proposal = project.graphProposal;
      if (proposal === null || proposal.id !== command.proposalId) {
        throw new DomainError('proposal_missing', '제안을 찾지 못했습니다');
      }
      if (proposal.state !== 'open') {
        throw new DomainError('proposal_decided', '이미 결정된 제안입니다');
      }
      const decided = { ...proposal, state: 'rejected' as const, decidedAt: ctx.at };
      return {
        project: { ...project, graphProposal: decided, updatedAt: ctx.at },
        events: [{ type: 'graph.proposal.rejected', proposalId: proposal.id }],
      };
    }

    // ── project ────────────────────────────────────────────────────────
    case 'project.rename': {
      const name = command.name.trim();
      if (name === '') throw new DomainError('invalid_input', '프로젝트에는 이름이 필요합니다');
      return {
        project: { ...project, name, updatedAt: ctx.at },
        events: [{ type: 'project.renamed', projectId: project.id, name }],
      };
    }

    // ── handoff package (F4) ───────────────────────────────────────────
    case 'project.package.export':
      // Writing files changes no project state; the event is the record.
      return {
        project,
        events: [{ type: 'package.exported', files: command.files }],
      };

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

/**
 * One decision card, one call: adopts whichever pin-derived proposal is on the
 * table. Kept beside `execute` so a caller (test, store revert path) does not
 * have to know the command name to spend a decision.
 */
export function applyGraphProposal(project: Project, ctx: ExecuteContext): ExecutionResult {
  const proposal = project.graphProposal;
  if (proposal === null) {
    throw new DomainError('proposal_missing', '제안을 찾지 못했습니다');
  }
  return execute(project, { type: 'graph.proposal.adopt', proposalId: proposal.id }, ctx);
}
