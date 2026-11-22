import { useEffect, useState } from 'react';
import { normalizeProject, ungroundedRequirements } from '@spec-studio/core';
import type { BlockType, Command, DocKind, Project } from '@spec-studio/protocol';
import type { DocMode } from '../components/DocPanel';
import type { EvidenceReqOption } from '../components/EvidencePanel';
import {
  DaemonClient,
  DaemonError,
  type RevertableView,
} from '../model/daemon';
import { activeDocOf, nowIso, type ApplyResult, type Notice } from '../model/appUtils';

/**
 * 문서 영역: the registry of docs on the project, which one is on screen
 * (the URL's pick), and every block/proposal/revert operation the panel
 * issues. Block commands all ride the shared `runDoc`/`applyCommand` path.
 */
export function useDocRegistry({
  client,
  project,
  setProject,
  daemonProjectId,
  applyCommand,
  runDoc,
  setBusy,
  revertable,
  setRevertable,
  setNotice,
}: {
  client: DaemonClient;
  project: Project | null;
  setProject: (project: Project) => void;
  daemonProjectId: string | null;
  applyCommand: (command: Command) => Promise<ApplyResult | null>;
  runDoc: (command: Command, after?: (result: ApplyResult) => void) => Promise<void>;
  setBusy: (busy: boolean) => void;
  revertable: RevertableView | null;
  setRevertable: (revertable: RevertableView | null) => void;
  setNotice: (notice: Notice | null) => void;
}) {
  const [docMode, setDocMode] = useState<DocMode>('direct');
  /** Which registry doc is open; the URL is the 정본, this is its echo. */
  const [activeDocId, setActiveDocId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('doc'),
  );
  const [focusBlockId, setFocusBlockId] = useState<string | null>(null);

  const docs = project?.docs ?? [];
  const doc = activeDocOf(docs, activeDocId);
  /** Handoff sheets print the spec, the same doc the daemon publishes. */
  const specDoc = activeDocOf(docs, null);
  // A doc's card is its *latest* proposal row — a fresh create appends behind
  // the decided one it retired, so the first match can be yesterday's card.
  const proposal =
    doc !== null
      ? (project?.proposals.filter((p) => p.docId === doc.id).at(-1) ?? null)
      : null;

  /** F3-3's spec-view warning: requirements no references→evidence link grounds. */
  const ungroundedReqs =
    project === null
      ? []
      : ungroundedRequirements(project).map((node) => ({ id: node.id, title: node.title }));
  const ungroundedIds = new Set(ungroundedReqs.map((req) => req.id));
  /** The evidence panel's 연결 targets: every requirement, 미근거 first. */
  const reqOptions: EvidenceReqOption[] =
    project === null
      ? []
      : project.graph.nodes
          .filter((node) => node.type === 'req')
          .map((node) => ({
            id: node.id,
            title: node.title,
            ungrounded: ungroundedIds.has(node.id),
          }));

  /** The URL names the doc on screen, so a reload — or a shared link — reopens it. */
  useEffect(() => {
    const url = new URL(window.location.href);
    if (doc === null) {
      if (!url.searchParams.has('doc')) return;
      url.searchParams.delete('doc');
    } else {
      if (url.searchParams.get('doc') === doc.id) return;
      url.searchParams.set('doc', doc.id);
    }
    window.history.replaceState(null, '', url);
  }, [doc]);

  const createDoc = (title: string, kind: DocKind) => {
    void runDoc({ type: 'doc.create', title, kind }, (result) => {
      const created = result.events.find((event) => event.type === 'doc.created');
      if (created !== undefined && created.type === 'doc.created') {
        setActiveDocId(created.doc.id);
      }
    });
  };

  const deleteDoc = (docId: string) => {
    void runDoc({ type: 'doc.delete', docId }, () => {
      // The deleted doc cannot stay the URL's pick; the next render falls back.
      setActiveDocId((current) => (current === docId ? null : current));
    });
  };

  /** F-4 (v16): title edits ride the same `doc.update` the ledger undoes. */
  const renameDoc = (docId: string, title: string) => {
    void runDoc({ type: 'doc.update', docId, title });
  };

  const addBlock = (afterBlockId: string | null) => {
    if (doc === null) return;
    void runDoc({
      type: 'doc.block.create',
      docId: doc.id,
      blockType: 'paragraph',
      text: '',
      afterBlockId,
    });
  };

  const updateBlockText = (blockId: string, text: string) => {
    if (doc === null) return;
    // F-1: the blur commit is invisible work — it must not flip the UI to
    // busy, because the click that caused the blur would land on controls a
    // frame later disabled, which is how the first interaction got eaten.
    void applyCommand({ type: 'doc.block.update', docId: doc.id, blockId, text });
  };

  const changeBlockType = (blockId: string, blockType: BlockType) => {
    if (doc === null) return;
    void runDoc({ type: 'doc.block.update', docId: doc.id, blockId, blockType });
  };

  const deleteBlock = (blockId: string) => {
    if (doc === null) return;
    void runDoc({ type: 'doc.block.delete', docId: doc.id, blockId });
  };

  const moveBlock = (blockId: string, afterBlockId: string | null) => {
    if (doc === null) return;
    void runDoc({ type: 'doc.block.move', docId: doc.id, blockId, afterBlockId });
  };

  const linkBlockPin = (blockId: string, pinId: string) => {
    if (doc === null) return;
    void runDoc({ type: 'doc.pin.link', docId: doc.id, blockId, pinId });
  };

  const unlinkBlockPin = (blockId: string, pinId: string) => {
    if (doc === null) return;
    void runDoc({ type: 'doc.pin.unlink', docId: doc.id, blockId, pinId });
  };

  /** Several badges can sit on one block; each clear is one command, in order. */
  const clearStale = async (blockId: string, pinIds: string[]) => {
    if (doc === null) return;
    setBusy(true);
    try {
      for (const pinId of pinIds) {
        await applyCommand({ type: 'doc.stale.clear', docId: doc.id, blockId, pinId });
      }
    } finally {
      setBusy(false);
    }
  };

  const createProposal = () => {
    if (doc === null) return;
    void runDoc({ type: 'proposal.create', docId: doc.id });
  };

  const decideProposal = (decision: 'adopt' | 'reject') => {
    if (doc === null || proposal === null) return;
    const proposalId = proposal.id;
    const summary = proposal.summary;
    const patches = proposal.patches.length;
    if (decision === 'reject') {
      void runDoc({ type: 'proposal.reject', docId: doc.id, proposalId });
      return;
    }
    void runDoc(
      { type: 'proposal.adopt', docId: doc.id, proposalId },
      (result) => {
        if (result.opSeq === undefined) return;
        setRevertable({
          seq: result.opSeq,
          at: nowIso(),
          summary,
          blocks: patches,
          kind: 'doc',
          op: 'proposal.adopt',
          nodes: 0,
          proposalId: proposalId,
        });
        setNotice({ tone: 'info', text: '제안을 채택했습니다. 문단이 갱신되었습니다.' });
      },
    );
  };

  /** Restores `op_log.before` — the exact block state before the adoption. */
  const revertAdopted = async () => {
    if (daemonProjectId === null || revertable === null) return;
    setBusy(true);
    try {
      const outcome = await client.revert(daemonProjectId, revertable.seq);
      setProject(normalizeProject(outcome.project));
      setRevertable(outcome.revert);
      // F-3: the toast names the operation actually undone — an adopt
      // message under a doc lifecycle revert was the wrong story.
      setNotice({
        tone: 'info',
        text:
          revertable.kind === 'graph'
            ? `그래프 채택 ${outcome.revertedSeq}번을 되돌렸습니다. 객체 ${revertable.nodes}개와 그 링크를 제거했습니다.`
            : revertable.op === 'proposal.adopt'
              ? `채택 ${outcome.revertedSeq}번을 되돌렸습니다. 문단 ${outcome.blocks}개를 채택 직전 상태로 복원했습니다.`
              : `${revertable.summary} — 되돌렸습니다.`,
      });
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof DaemonError ? error.message : '되돌리지 못했습니다.',
      });
    } finally {
      setBusy(false);
    }
  };

  return {
    docMode,
    setDocMode,
    activeDocId,
    setActiveDocId,
    focusBlockId,
    setFocusBlockId,
    docs,
    doc,
    specDoc,
    proposal,
    ungroundedReqs,
    reqOptions,
    createDoc,
    deleteDoc,
    renameDoc,
    addBlock,
    updateBlockText,
    changeBlockType,
    deleteBlock,
    moveBlock,
    linkBlockPin,
    unlinkBlockPin,
    clearStale,
    createProposal,
    decideProposal,
    revertAdopted,
  };
}
