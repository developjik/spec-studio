import {
  PinSchema,
  ScreenSchema,
  linkEndsAllow,
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
import {
  extractGraphProposal,
  makeGraphNode,
  markLinksSuspect,
  nodeStateOptions,
  normalizeGraph,
  resolveProposalRef,
} from './graph';
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
  | 'graphProposal';

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
    doc: null,
    proposal: null,
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

/** The type a link endpoint stands for, or null when the id is not in the project. */
export function graphNodeType(project: Project, id: string) {
  if (project.screen !== null && project.screen.id === id) return 'screen' as const;
  if (project.pins.some((pin) => pin.id === id)) return 'pin' as const;
  const node = findGraphNode(project, id);
  return node === undefined ? null : node.type;
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
      const srcType = graphNodeType(project, command.src);
      const dstType = graphNodeType(project, command.dst);
      if (srcType === null || dstType === null) {
        throw new DomainError('node_not_found', '링크의 한쪽 객체를 찾지 못했습니다');
      }
      if (command.src === command.dst) {
        throw new DomainError('invalid_input', '같은 객체로는 링크할 수 없습니다');
      }
      if (!linkEndsAllow(command.linkType, srcType, dstType)) {
        throw new DomainError(
          'invalid_input',
          `${command.linkType} 링크는 ${srcType} → ${dstType} 를 연결할 수 없습니다`,
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
      return {
        project: {
          ...project,
          graph: { ...project.graph, links: [...project.graph.links, link] },
          updatedAt: ctx.at,
        },
        events: [{ type: 'link.created', link }],
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
      const proposal = extractGraphProposal(project, {
        id: ctx.nextId('graphProposal'),
        at: ctx.at,
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
      const links: GraphLink[] = [...project.graph.links];
      for (const draft of proposal.links) {
        const src = resolveProposalRef(draft.src, created);
        const dst = resolveProposalRef(draft.dst, created);
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
      const decided = { ...proposal, state: 'adopted' as const, decidedAt: ctx.at };
      return {
        project: {
          ...project,
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
