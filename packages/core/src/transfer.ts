import type {
  Block,
  Doc,
  EditableNodeType,
  GraphLink,
  GraphNode,
  Pin,
  Project,
} from '@spec-studio/protocol';
import { normalizeProject, type IdKind } from './project';

/**
 * Import is a copy, not a link. Every id in the bundle is replaced so the new
 * project can live beside the one it came from — two projects naming the same
 * block would make the ledger lie about which file changed. References are
 * rewritten in one pass (screen → pins → nodes → links → doc → blocks), so a
 * block still cites the pin it did in the bundle.
 */
export type RemapId = (kind: IdKind, nodeType?: EditableNodeType) => string;

export function remapProject(project: Project, nextId: RemapId): Project {
  project = normalizeProject(project);
  const screens = project.screens ?? (project.screen ? [project.screen] : []);
  const screenIds = new Map(screens.map((s) => [s.id, nextId('screen')]));
  const pinIds = new Map<string, string>();
  for (const pin of project.pins) pinIds.set(pin.id, nextId('pin'));
  const nodeIds = new Map<string, string>();
  for (const node of project.graph.nodes) nodeIds.set(node.id, nextId('node', node.type));
  const ideaIds = new Map<string, string>();
  for (const idea of project.ideas) ideaIds.set(idea.id, nextId('idea'));
  const evidenceIds = new Map<string, string>();
  for (const evidence of project.evidence) evidenceIds.set(evidence.id, nextId('evidence'));

  const mapRef = (id: string): string | null => {
    if (screenIds.has(id)) return screenIds.get(id)!;
    return pinIds.get(id) ?? nodeIds.get(id) ?? ideaIds.get(id) ?? evidenceIds.get(id) ?? null;
  };

  const pins: Pin[] = project.pins.map((pin) => ({
    ...pin,
    id: pinIds.get(pin.id)!,
    screenId: screenIds.get(pin.screenId)!,
  }));

  const nodes: GraphNode[] = project.graph.nodes.map((node) => ({
    ...node,
    id: nodeIds.get(node.id)!,
  }));

  const links: GraphLink[] = [];
  for (const link of project.graph.links) {
    const src = mapRef(link.src);
    const dst = mapRef(link.dst);
    // An edge to an object the bundle did not carry has no meaning here.
    if (src === null || dst === null) continue;
    links.push({ ...link, id: nextId('link'), src, dst });
  }

  const ideas = project.ideas.map((idea) => ({
    ...idea,
    id: ideaIds.get(idea.id)!,
  }));
  const evidence = project.evidence.map((row) => ({
    ...row,
    id: evidenceIds.get(row.id)!,
  }));
  const docs = project.docs.map((doc) => ({
    ...remapDoc(doc, nextId, pinIds),
    screenId: doc.screenId ? (screenIds.get(doc.screenId) ?? null) : null,
  }));

  return {
    ...project,
    id: nextId('project'),
    screens: screens.map((s) => ({ ...s, id: screenIds.get(s.id)! })),
    activeScreenId: project.screen ? screenIds.get(project.screen.id)! : null,
    screenPinSeq: Object.fromEntries(
      screens.map((s) => [
        screenIds.get(s.id)!,
        project.screenPinSeq?.[s.id] ?? (project.screen?.id === s.id ? project.pinSeq : 0),
      ]),
    ),
    screen:
      project.screen === null
        ? null
        : {
            ...project.screen,
            id: screenIds.get(project.screen.id)!,
            createdAt: project.screen.createdAt,
          },
    pins,
    docs,
    proposals: [],
    ideas,
    evidence,
    graph: { nodes, links },
    graphProposal: null,
    updatedAt: project.updatedAt,
  };
}

function remapDoc(doc: Doc, nextId: RemapId, pinIds: ReadonlyMap<string, string>): Doc {
  const blockIds = new Map<string, string>();
  for (const block of doc.blocks) blockIds.set(block.id, nextId('block'));
  const blocks: Block[] = doc.blocks.map((block) => ({
    ...block,
    id: blockIds.get(block.id)!,
    pinRefs: block.pinRefs
      .map((ref) => {
        const pinId = pinIds.get(ref.pinId);
        return pinId === undefined ? null : { ...ref, pinId };
      })
      .filter((ref): ref is Block['pinRefs'][number] => ref !== null),
  }));
  return { ...doc, id: nextId('doc'), blocks };
}
