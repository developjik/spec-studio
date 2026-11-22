import { useEffect, useState } from 'react';
import type { Command, Idea, Project } from '@spec-studio/protocol';
import type { InboxCaptureInput } from '../components/IdeaInboxPanel';
import type { EvidenceClipInput } from '../components/EvidencePanel';
import type { ApplyResult, Notice } from '../model/appUtils';

/**
 * 인박스 영역: the F2 quick capture (desktop shortcut and in-app button open
 * the same modal), idea capture/archive/promote, and the F3 evidence ops the
 * research board issues.
 */
export function useIdeaInbox({
  project,
  applyCommand,
  runDoc,
  reload,
  setBusy,
  setActiveDocId,
  setNotice,
}: {
  project: Project | null;
  applyCommand: (command: Command) => Promise<ApplyResult | null>;
  runDoc: (command: Command, after?: (result: ApplyResult) => void) => Promise<void>;
  reload: () => Promise<void>;
  setBusy: (busy: boolean) => void;
  setActiveDocId: (docId: string) => void;
  setNotice: (notice: Notice | null) => void;
}) {
  /** F2 quick capture: the desktop shortcut and the in-app button both open it. */
  const [inboxCaptureOpen, setInboxCaptureOpen] = useState(false);

  /**
   * The desktop shell's global shortcut pings; the browser build has no
   * `window.specstudio` and keeps the in-app 빠른 캡처 button as the only path.
   */
  useEffect(() => {
    const off = window.specstudio?.onQuickCapture?.(() => setInboxCaptureOpen(true));
    return () => off?.();
  }, []);

  const captureIdea = (input: InboxCaptureInput) => {
    if (project === null) {
      setNotice({ tone: 'error', text: '프로젝트를 먼저 열어야 인박스에 저장할 수 있습니다.' });
      return;
    }
    // Image paste stays a screen-only thing: a data URL cannot ride the
    // command's 500-char `image` path field, so the inbox takes text + URL.
    const trimmedUrl = input.url.trim();
    void runDoc({
      type: 'idea.capture',
      text: input.text,
      ...(trimmedUrl === '' ? {} : { url: trimmedUrl }),
    });
  };

  const archiveIdea = (ideaId: string) => {
    void runDoc({ type: 'idea.archive', ideaId });
  };

  /**
   * 승격 = 두 순차 커맨드 (§4 F2): the spec doc first, then the state move —
   * both op_log'd, so the promotion is as undoable as the doc it created.
   */
  const promoteIdea = async (idea: Idea) => {
    setBusy(true);
    try {
      const created = await applyCommand({
        type: 'doc.create',
        title: idea.title.slice(0, 120),
        kind: 'spec',
      });
      if (created === null) return;
      const docCreated = created.events.find((event) => event.type === 'doc.created');
      await applyCommand({ type: 'idea.update', ideaId: idea.id, state: 'promoted' });
      if (docCreated !== undefined && docCreated.type === 'doc.created') {
        // MN-A (v16): a promoted spec never opens empty — the summary of the
        // brief that answered this idea, which `proposal.ideaId` carries
        // across restarts, else the idea's own text.
        const seed =
          project?.proposals.filter((candidate) => candidate.ideaId === idea.id).at(-1)
            ?.summary ?? idea.text;
        await applyCommand({
          type: 'doc.block.create',
          docId: docCreated.doc.id,
          blockType: 'paragraph',
          text: seed,
        });
        setActiveDocId(docCreated.doc.id);
      }
      setNotice({ tone: 'info', text: `아이디어를 스펙 문서로 승격했습니다: ${idea.title}` });
    } finally {
      setBusy(false);
    }
  };

  const captureEvidence = (input: EvidenceClipInput) => {
    void runDoc({
      type: 'evidence.capture',
      url: input.url,
      excerpt: input.excerpt,
      evidenceType: input.evidenceType,
      ...(input.title === '' ? {} : { title: input.title }),
    });
  };

  const dismissEvidence = (evidenceId: string) => {
    void runDoc({ type: 'evidence.dismiss', evidenceId });
  };

  /** F3-3: the same `link.create` the graph speaks — references → evidence. */
  const linkEvidence = (srcNodeId: string, evidenceId: string) => {
    void runDoc(
      { type: 'link.create', linkType: 'references', src: srcNodeId, dst: evidenceId },
      () => void reload(),
    );
  };

  return {
    inboxCaptureOpen,
    setInboxCaptureOpen,
    captureIdea,
    archiveIdea,
    promoteIdea,
    captureEvidence,
    dismissEvidence,
    linkEvidence,
  };
}
