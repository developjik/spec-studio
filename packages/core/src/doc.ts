import {
  BlockSchema,
  type AiBriefDraft,
  type AiDocDraft,
  type Block,
  type BlockPinRef,
  type BlockSnapshotEntry,
  type BlockStale,
  type Doc,
  type DocKind,
  type DocSnapshot,
  type Evidence,
  type Pin,
  type Proposal,
  type ProposalPatch,
} from '@spec-studio/protocol';
import { DomainError } from './errors';

/**
 * The document's pure half: what a block stands on, what makes it stale, what
 * a proposal would change, and how an adopted change is put back. Nothing here
 * reads the clock, the disk or the database — the caller supplies the time, the
 * ids and the snapshots, which is what lets the same code run in the browser
 * and inside the store's transaction.
 */

export const PIN_CITATION_MARK = '\n\n[핀] ';

/**
 * A pin's spec as the sentence that cites it cares about: type, title and body.
 * The anchor is left out on purpose — moving a pin on the image never makes a
 * paragraph false, so it must not raise a stale badge.
 */
export function pinFingerprint(pin: Pick<Pin, 'type' | 'title' | 'body'>): string {
  const canonical = `${pin.type}\u0000${pin.title}\u0000${pin.body}`;
  // djb2, hex. Core has no crypto and does not need one: this only has to
  // differ when the spec differs, and to be reproducible across processes.
  let hash = 5381;
  for (let index = 0; index < canonical.length; index += 1) {
    hash = ((hash << 5) + hash + canonical.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function createDoc(input: {
  id: string;
  title: string;
  at: string;
  /** Registry kind; a screen's auto-doc and W4-era docs are specs. */
  kind?: DocKind;
}): Doc {
  const title = input.title.trim();
  if (title === '') throw new DomainError('invalid_input', '문서에는 제목이 필요합니다');
  return {
    id: input.id,
    title: title.slice(0, 120),
    rev: 0,
    blocks: [],
    kind: input.kind ?? 'spec',
    deletedAt: null,
    createdAt: input.at,
    updatedAt: input.at,
  };
}

export function findBlock(doc: Doc, blockId: string): Block | undefined {
  return doc.blocks.find((block) => block.id === blockId);
}

export function blockIndex(doc: Doc, blockId: string): number {
  return doc.blocks.findIndex((block) => block.id === blockId);
}

/** Every block that cites this pin — the pin panel's "참조 문단" list. */
export function blocksForPin(doc: Doc, pinId: string): Block[] {
  return doc.blocks.filter((block) => block.pinRefs.some((ref) => ref.pinId === pinId));
}

/**
 * The stale badges the editor paints. A link is stale when the pin's spec
 * differs from the one the link recorded, or when the pin is gone. A person
 * clearing the badge re-baselines the link; a proposal adopts the new text.
 */
export function staleBadges(doc: Doc, pins: readonly Pin[]): BlockStale[] {
  const byId = new Map(pins.map((pin) => [pin.id, pin] as const));
  const badges: BlockStale[] = [];
  for (const block of doc.blocks) {
    for (const ref of block.pinRefs) {
      const pin = byId.get(ref.pinId);
      if (pin === undefined) {
        badges.push({ blockId: block.id, pinId: ref.pinId, reason: 'pin-missing' });
        continue;
      }
      if (pinFingerprint(pin) !== ref.fingerprint) {
        badges.push({ blockId: block.id, pinId: ref.pinId, reason: 'pin-changed' });
      }
    }
  }
  return badges;
}

export function staleForBlock(doc: Doc, pins: readonly Pin[], blockId: string): BlockStale[] {
  return staleBadges(doc, pins).filter((badge) => badge.blockId === blockId);
}

/** The prose a person wrote, with any generated pin citation removed. */
export function proseOf(text: string): string {
  const at = text.indexOf(PIN_CITATION_MARK);
  return at < 0 ? text : text.slice(0, at);
}

/** The generated citation line for a set of refs, or '' when there are none. */
export function citationLine(refs: readonly BlockPinRef[], pins: readonly Pin[]): string {
  if (refs.length === 0) return '';
  const byId = new Map(pins.map((pin) => [pin.id, pin] as const));
  const parts = refs.map((ref) => {
    const pin = byId.get(ref.pinId);
    return pin === undefined ? '#? 삭제된 핀' : `#${pin.number} ${pin.title}`;
  });
  return PIN_CITATION_MARK + parts.join('\n[핀] ');
}

/** Prose + the citation of the pins it stands on, regenerated from current facts. */
export function syncBlockText(
  text: string,
  refs: readonly BlockPinRef[],
  pins: readonly Pin[],
): string {
  const prose = proseOf(text).replace(/\s+$/, '');
  const citation = citationLine(refs, pins);
  return citation === '' ? prose : `${prose}${citation}`;
}

/** Re-baseline one link to the pin as it is now. */
export function confirmRef(ref: BlockPinRef, pin: Pin, at: string): BlockPinRef {
  return { pinId: ref.pinId, fingerprint: pinFingerprint(pin), linkedAt: at };
}

function newRef(pin: Pin, at: string): BlockPinRef {
  return { pinId: pin.id, fingerprint: pinFingerprint(pin), linkedAt: at };
}

export function makeBlock(input: {
  id: string;
  type: Block['type'];
  text: string;
  pinRefs?: BlockPinRef[];
  at: string;
}): Block {
  return BlockSchema.parse({
    id: input.id,
    type: input.type,
    text: input.text,
    pinRefs: input.pinRefs ?? [],
    createdAt: input.at,
    updatedAt: input.at,
  });
}

export function withBlocks(doc: Doc, blocks: Block[], at: string, bumpRev = true): Doc {
  return {
    ...doc,
    blocks,
    rev: bumpRev ? doc.rev + 1 : doc.rev,
    updatedAt: at,
  };
}

/** Inserts `block` after `afterBlockId`; `null` means the top of the document. */
export function insertBlock(doc: Doc, block: Block, afterBlockId: string | null): Block[] {
  if (findBlock(doc, block.id) !== undefined) {
    throw new DomainError('invalid_input', '이미 있는 id로 문단을 추가할 수 없습니다');
  }
  const anchor = afterBlockId === null ? -1 : blockIndex(doc, afterBlockId);
  if (afterBlockId !== null && anchor < 0) {
    throw new DomainError('block_not_found', '기준 문단을 찾지 못했습니다');
  }
  const blocks = [...doc.blocks];
  blocks.splice(anchor + 1, 0, block);
  return blocks;
}

/** Moves a block next to another; the moved block keeps its id and text. */
export function moveBlock(
  doc: Doc,
  blockId: string,
  afterBlockId: string | null,
  at: string,
): Block[] {
  const current = findBlock(doc, blockId);
  if (current === undefined) throw new DomainError('block_not_found', '문단을 찾지 못했습니다');
  if (afterBlockId === blockId) return [...doc.blocks];
  const rest = doc.blocks.filter((block) => block.id !== blockId);
  const anchor = afterBlockId === null ? -1 : rest.findIndex((block) => block.id === afterBlockId);
  if (afterBlockId !== null && anchor < 0) {
    throw new DomainError('block_not_found', '기준 문단을 찾지 못했습니다');
  }
  const blocks = [...rest];
  blocks.splice(anchor + 1, 0, { ...current, updatedAt: at });
  return blocks;
}

export function blockRefFor(pin: Pin, at: string): BlockPinRef {
  return newRef(pin, at);
}

/**
 * Builds one queueable proposal from a screen: every block whose pin facts
 * moved gets new citation text, and when nothing is stale the proposal adds
 * the pin summary paragraph the document is missing. The patches carry both
 * sides so the decision card can show them and the store can keep `before`.
 */
export function buildProposal(input: {
  id: string;
  doc: Doc;
  pins: readonly Pin[];
  at: string;
}): Proposal {
  const { doc, pins } = input;
  const badges = staleBadges(doc, pins);
  const byId = new Map(pins.map((pin) => [pin.id, pin] as const));
  const patches: ProposalPatch[] = [];
  const touched = new Set<string>();

  for (const badge of badges) {
    if (touched.has(badge.blockId)) continue;
    touched.add(badge.blockId);
    const block = findBlock(doc, badge.blockId);
    if (block === undefined) continue;
    // A pin that vanished loses its citation; a pin that changed keeps it.
    const refs = block.pinRefs
      .filter((ref) => byId.has(ref.pinId))
      .map((ref) => confirmRef(ref, byId.get(ref.pinId) as Pin, input.at));
    patches.push({
      blockId: block.id,
      afterBlockId: null,
      before: { type: block.type, text: block.text, pinRefs: block.pinRefs },
      after: { type: block.type, text: syncBlockText(block.text, refs, pins), pinRefs: refs },
    });
  }

  if (patches.length === 0) {
    if (pins.length === 0) {
      throw new DomainError('invalid_input', '제안할 핀이 없습니다. 먼저 화면에 핀을 찍어 주세요');
    }
    const refs = pins.map((pin) => newRef(pin, input.at));
    const type: Block['type'] = doc.blocks.length === 0 ? 'paragraph' : 'list';
    const text = syncBlockText(
      doc.blocks.length === 0
        ? '이 화면에서 확인할 것:'
        : '이 화면의 핀을 문서에 정리했습니다:',
      refs,
      pins,
    );
    patches.push({
      blockId: `B_${input.id.replace(/^PR_/, '').slice(0, 12).padEnd(12, '0')}`,
      afterBlockId: doc.blocks.at(-1)?.id ?? null,
      before: null,
      after: { type, text, pinRefs: refs },
    });
  }

  const changed = patches.filter((patch) => patch.before !== null).length;
  const added = patches.length - changed;
  const numbers = pins
    .filter((pin) => badges.some((badge) => badge.pinId === pin.id))
    .map((pin) => `#${pin.number}`);
  const summaryParts: string[] = [];
  if (changed > 0) {
    summaryParts.push(
      `${numbers.length > 0 ? numbers.join('·') : ''} 핀이 바뀐 문단 ${changed}개를 새 내용으로 맞춥니다`,
    );
  }
  if (added > 0) summaryParts.push(`핀 ${pins.length}개를 문서에 정리하는 문단 1개를 더합니다`);

  return {
    id: input.id,
    docId: doc.id,
    summary: summaryParts.join(', ') || '문서를 핀과 맞춥니다',
    origin: 'pin',
    baseRev: doc.rev,
    state: 'open',
    patches,
    createdAt: input.at,
    decidedAt: null,
  };
}

/**
 * Turns a model's paragraph draft into the same proposal card a person
 * already decides on: `before` is read from the document as it is now, so the
 * store keeps exactly the text a `되돌리기` would put back. A block id the
 * document does not have is an error, not a quietly skipped patch — an answer
 * that names the wrong paragraph is not a proposal, it is a mistake.
 */
export function buildProposalFromDraft(input: {
  id: string;
  doc: Doc;
  pins: readonly Pin[];
  draft: AiDocDraft;
  at: string;
}): Proposal {
  const { doc, pins, draft } = input;
  const byNumber = new Map(pins.map((pin) => [pin.number, pin] as const));
  const byId = new Map(pins.map((pin) => [pin.id, pin] as const));
  const patches: ProposalPatch[] = [];

  for (const draftPatch of draft.patches) {
    const block = findBlock(doc, draftPatch.blockId);
    if (block === undefined) {
      throw new DomainError(
        'block_not_found',
        '제안이 이 문서에 없는 문단을 가리킵니다. 다시 추출해 주세요.',
      );
    }
    const kept = block.pinRefs.filter((ref) => byId.has(ref.pinId));
    const cited = draftPatch.pins
      .map((number) => byNumber.get(number))
      .filter((pin): pin is Pin => pin !== undefined);
    // A patch that cites nothing keeps what the paragraph already stood on.
    const target = cited.length === 0 ? kept.map((ref) => byId.get(ref.pinId) as Pin) : cited;
    const refs: BlockPinRef[] = [];
    for (const pin of target) {
      if (refs.some((ref) => ref.pinId === pin.id)) continue;
      refs.push(newRef(pin, input.at));
    }
    const after = {
      type: block.type,
      text: syncBlockText(draftPatch.text, refs, pins),
      pinRefs: refs,
    };
    const unchanged =
      after.text === block.text &&
      after.pinRefs.length === block.pinRefs.length &&
      after.pinRefs.every((ref, index) => ref.pinId === block.pinRefs[index]?.pinId);
    if (unchanged) continue;
    patches.push({
      blockId: block.id,
      afterBlockId: null,
      before: { type: block.type, text: block.text, pinRefs: block.pinRefs },
      after,
    });
  }

  if (patches.length === 0) {
    throw new DomainError('invalid_input', '제안된 문단이 지금 문서와 같습니다. 바뀐 것이 없습니다.');
  }

  return {
    id: input.id,
    docId: doc.id,
    summary: draft.summary.trim().slice(0, 300),
    // `doc-chat` is the origin that already means "a sentence proposed outside
    // the pin extractor"; the card reads it as an LLM 제안.
    origin: 'doc-chat',
    baseRev: doc.rev,
    state: 'open',
    patches,
    createdAt: input.at,
    decidedAt: null,
  };
}

/**
 * Turns a research brief (F3-2) into the same card a person already decides
 * on — here every patch inserts a block at the end of the document: the
 * title as a heading, the summary, then one paragraph per claim with its
 * sources spelled out (`(출처: …)`) or the honest `(근거 없음)` marker.
 *
 * The trust boundary is the first loop: a claim citing an evidence id the
 * board does not have is rejected here, before any card exists — 채택 전
 * 거부, the same rule the pin verifier already follows.
 */
export function buildProposalFromBrief(input: {
  id: string;
  doc: Doc;
  evidence: readonly Evidence[];
  draft: AiBriefDraft;
  at: string;
}): Proposal {
  const { doc, draft } = input;
  const byId = new Map(input.evidence.map((row) => [row.id, row] as const));
  for (const claim of draft.claims) {
    for (const ref of claim.evidenceRefs) {
      if (!byId.has(ref)) {
        throw new DomainError('invalid_input', `없는 근거를 인용했습니다: ${ref}`);
      }
    }
  }

  const claimText = (claim: AiBriefDraft['claims'][number]): string => {
    if (claim.evidenceRefs.length === 0) return `${claim.text} (근거 없음)`;
    const titles = claim.evidenceRefs.map((ref) => byId.get(ref)?.title ?? ref);
    return `${claim.text} (출처: ${titles.join(', ')})`;
  };

  const blocks: Array<{ type: Block['type']; text: string }> = [
    { type: 'heading', text: draft.title },
    { type: 'paragraph', text: draft.summary },
    ...draft.claims.map((claim) => ({ type: 'paragraph' as const, text: claimText(claim) })),
  ];
  const suffix = input.id.replace(/^PR_/, '').slice(0, 12).padEnd(12, '0');
  let anchor = doc.blocks.at(-1)?.id ?? null;
  const patches: ProposalPatch[] = blocks.map((block, index) => {
    const blockId = `B_${suffix}${String(index).padStart(2, '0')}`;
    const patch: ProposalPatch = {
      blockId,
      afterBlockId: anchor,
      before: null,
      after: { type: block.type, text: block.text, pinRefs: [] },
    };
    anchor = blockId;
    return patch;
  });

  return {
    id: input.id,
    docId: doc.id,
    summary: `${draft.title} — 브리프 주장 ${draft.claims.length}개`.slice(0, 300),
    // `doc-chat` remains the origin for anything proposed outside the pin
    // extractor; the brief's insert-only patches and 출처 markers are what
    // the card reads. (The proposal table's origin CHECK has no 'brief'.)
    origin: 'doc-chat',
    baseRev: doc.rev,
    state: 'open',
    patches,
    createdAt: input.at,
    decidedAt: null,
  };
}

/** Applies a proposal's patches. Ids come from the proposal, so a revert names the same blocks. */
export function applyPatches(
  doc: Doc,
  patches: readonly ProposalPatch[],
  at: string,
): { doc: Doc; created: string[] } {
  let blocks = [...doc.blocks];
  const created: string[] = [];
  for (const patch of patches) {
    const current = blocks.find((block) => block.id === patch.blockId);
    if (patch.before === null) {
      if (current !== undefined) {
        throw new DomainError('invalid_input', '이미 있는 문단을 추가하려 했습니다');
      }
      const block = makeBlock({
        id: patch.blockId,
        type: patch.after.type,
        text: patch.after.text,
        pinRefs: patch.after.pinRefs,
        at,
      });
      blocks = insertBlock({ ...doc, blocks }, block, patch.afterBlockId);
      created.push(block.id);
      continue;
    }
    if (current === undefined) throw new DomainError('block_not_found', '문단을 찾지 못했습니다');
    blocks = blocks.map((block) =>
      block.id === patch.blockId
        ? { ...block, type: patch.after.type, text: patch.after.text, pinRefs: patch.after.pinRefs, updatedAt: at }
        : block,
    );
  }
  return { doc: withBlocks(doc, blocks, at), created };
}

/**
 * The `op_log.before` value for a set of patches: which blocks existed, what
 * they held and where they sat. The store writes this in the same transaction
 * that applies the patches, so a revert never has to trust in-memory state.
 */
export function snapshotForPatches(doc: Doc, patches: readonly ProposalPatch[]): DocSnapshot {
  const entries: BlockSnapshotEntry[] = patches.map((patch) => {
    if (patch.before !== null) {
      const index = Math.max(0, blockIndex(doc, patch.blockId));
      return {
        blockId: patch.blockId,
        existed: true,
        type: patch.before.type,
        text: patch.before.text,
        pinRefs: patch.before.pinRefs,
        index,
      };
    }
    const anchor =
      patch.afterBlockId === null ? -1 : blockIndex(doc, patch.afterBlockId);
    return {
      blockId: patch.blockId,
      existed: false,
      type: null,
      text: null,
      pinRefs: null,
      index: anchor + 1,
    };
  });
  return { docId: doc.id, rev: doc.rev, entries };
}

/**
 * Puts a snapshot back: blocks that existed return with their text, pins and
 * position, and blocks the operation added are removed. Untouched blocks keep
 * whatever they hold, so a revert of an old operation does not wipe later work
 * outside it.
 */
export function restoreSnapshot(doc: Doc, snapshot: DocSnapshot, at: string): Doc {
  const affected = new Set(snapshot.entries.map((entry) => entry.blockId));
  const before = new Map(doc.blocks.map((block) => [block.id, block] as const));
  let blocks = doc.blocks.filter((block) => !affected.has(block.id));

  for (const entry of snapshot.entries) {
    if (!entry.existed) continue;
    const previous = before.get(entry.blockId);
    const restored = BlockSchema.parse({
      id: entry.blockId,
      type: entry.type ?? previous?.type ?? 'paragraph',
      text: entry.text ?? '',
      pinRefs: entry.pinRefs ?? [],
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
    });
    const at2 = Math.min(Math.max(0, entry.index), blocks.length);
    blocks = [...blocks.slice(0, at2), restored, ...blocks.slice(at2)];
  }

  return withBlocks(doc, blocks, at);
}

/** A compact line for the history list: what an adopted operation changed. */
export function proposalSummary(proposal: Proposal): string {
  return proposal.summary;
}

/** Open cards in persistent queue order; stable ties keep creation order. */
export function proposalQueue(proposals: readonly Proposal[], docId: string): Proposal[] {
  return proposals.filter(p => p.docId === docId && p.state === 'open')
    .sort((a,b) => (a.queueOrder ?? 0) - (b.queueOrder ?? 0) || (a.queuedAt ?? a.createdAt).localeCompare(b.queuedAt ?? b.createdAt));
}
export function proposalConflicts(proposal: Proposal, queue: readonly Proposal[]): string[] {
  const blocks = new Set(proposal.patches.map(p => p.blockId));
  return queue.filter(p => p.id !== proposal.id && p.docId === proposal.docId && p.state === 'open' && p.patches.some(patch => blocks.has(patch.blockId))).map(p => p.id);
}

/** Compare the semantic base, independent of object property insertion order. */
export function proposalIsStale(doc: Doc, proposal: Proposal): boolean {
  const sameRefs = (a: readonly BlockPinRef[], b: readonly BlockPinRef[]) =>
    a.length === b.length && a.every((ref, i) => {
      const other = b[i];
      return other !== undefined && ref.pinId === other.pinId && ref.fingerprint === other.fingerprint && ref.linkedAt === other.linkedAt;
    });
  return proposal.patches.some(patch => {
    const current = findBlock(doc, patch.blockId);
    if (patch.before === null) return current !== undefined;
    return current === undefined || current.type !== patch.before.type || current.text !== patch.before.text || !sameRefs(current.pinRefs, patch.before.pinRefs);
  });
}
