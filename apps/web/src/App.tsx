import { useEffect, useRef, useState } from 'react';
import {
  createProject,
  evaluateMaturityLevel,
  execute,
  graphViewNodes,
  normalizeProject,
  traceability,
  ungroundedRequirements,
  type ExecutionResult,
  type Maturity,
} from '@spec-studio/core';
import type {
  AiProposalMode,
  AiProposalSource,
  Anchor,
  BlockType,
  Command,
  DomainEvent,
  Doc,
  DocKind,
  Idea,
  Pin,
  Project,
  Screen,
} from '@spec-studio/protocol';
import type { PinFilter } from '@spec-studio/core';
import { TopBar, type StudioView } from './components/TopBar';
import { GraphView } from './components/GraphView';
import { EntryGate } from './components/EntryGate';
import { CanvasStage } from './components/CanvasStage';
import { PinPanel } from './components/PinPanel';
import { IdeaInboxPanel, type InboxCaptureInput } from './components/IdeaInboxPanel';
import {
  EvidencePanel,
  type EvidenceClipInput,
  type EvidenceReqOption,
} from './components/EvidencePanel';
import type { PinDraftInput } from './components/PinComposer';
import type { PinEditInput } from './components/PinEditor';
import { OutputModal } from './components/OutputModal';
import { PublishModal } from './components/PublishModal';
import { FigmaBar } from './components/FigmaBar';
import {
  AiSettingsModal,
  type AiPanelResult,
  type AiSettingsValue,
} from './components/AiSettingsModal';
import { DocPanel, type DocMode } from './components/DocPanel';
import { newProjectId, newScreenId, nextEntityId } from './model/ids';
import {
  bundleOf,
  clearStoredProject,
  downloadBundle,
  loadProject,
  parseBundleFile,
  saveProject,
} from './model/storage';
import { imageFromFile } from './model/image';
import {
  DaemonClient,
  DaemonError,
  daemonProbeAllowed,
  type AiStatusView,
  type DaemonStatus,
  type PublishRecordView,
  type RevertableView,
} from './model/daemon';
import {
  SAMPLE_CODE,
  SAMPLE_HEIGHT,
  SAMPLE_IMAGE,
  SAMPLE_TITLE,
  SAMPLE_WIDTH,
} from './model/sample';

type Notice = { tone: 'info' | 'error'; text: string };

const nowIso = () => new Date().toISOString();

const nextId = (
  kind:
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
    | 'evidence',
  nodeType?: 'req' | 'policy' | 'contract' | 'qa',
) => nextEntityId(kind, nodeType);

/** Before a project exists the header still needs a badge; L0 with no checks. */
const EMPTY_MATURITY: Maturity = {
  level: 'L0',
  levels: [
    { level: 'L0', checks: [] },
    { level: 'L1', checks: [] },
    { level: 'L2', checks: [] },
  ],
  next: { level: 'L1', todo: [] },
  todo: [],
};
/** What a command application returns; `opSeq` is the store's undo handle. */
type ApplyResult = ExecutionResult & { opSeq?: number };

/**
 * Which registry doc the panel shows: the URL's pick when it still exists,
 * else the first spec, else whatever exists. The URL is the 정본 of the choice,
 * so a dangling id simply falls through to the same rule a boot follows.
 */
function activeDocOf(docs: readonly Doc[], wanted: string | null): Doc | null {
  if (wanted !== null) {
    const named = docs.find((doc) => doc.id === wanted);
    if (named !== undefined) return named;
  }
  return docs.find((doc) => doc.kind === 'spec') ?? docs[0] ?? null;
}

export default function App() {
  const client = useRef(new DaemonClient()).current;
  const [project, setProject] = useState<Project | null>(() => loadProject());
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatus>('checking');
  const [daemonProjectId, setDaemonProjectId] = useState<string | null>(null);
  const [publishes, setPublishes] = useState<PublishRecordView[]>([]);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [filter, setFilter] = useState<PinFilter>('all');
  const [draftAnchor, setDraftAnchor] = useState<Anchor | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [docMode, setDocMode] = useState<DocMode>('direct');
  /** Which registry doc is open; the URL is the 정본, this is its echo. */
  const [activeDocId, setActiveDocId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('doc'),
  );
  const [focusBlockId, setFocusBlockId] = useState<string | null>(null);
  const [revertable, setRevertable] = useState<RevertableView | null>(null);
  const [aiCardSource, setAiCardSource] = useState<{
    proposalId: string;
    source: AiProposalSource;
  } | null>(null);
  /** F2 quick capture: the desktop shortcut and the in-app button both open it. */
  const [inboxCaptureOpen, setInboxCaptureOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<StudioView>('studio');
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiStatus, setAiStatus] = useState<AiStatusView | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<AiPanelResult | null>(null);
  const [aiSource, setAiSource] = useState<AiProposalSource | null>(null);
  /**
   * Session memory only. The key is never written to localStorage, the project
   * or the daemon — closing the tab forgets it, which is the point.
   */
  const [aiSettings, setAiSettings] = useState<AiSettingsValue>({
    presetId: 'anthropic',
    provider: 'anthropic',
    model: '',
    endpoint: 'https://api.anthropic.com',
    apiKey: '',
    saveToKeychain: false,
  });
  const importInput = useRef<HTMLInputElement>(null);
  const fileHandler = useRef<(file: File) => void>(() => undefined);
  /** ideaId → 브리프 카드 요약 — 승격 시 새 스펙 첫 문단의 씨앗 (MN-2). */
  const briefSeeds = useRef(new Map<string, string>());

  /** On boot: if the loopback daemon answers, SQLite becomes the source of truth. */
  useEffect(() => {
    let alive = true;
    if (!daemonProbeAllowed()) {
      setDaemonStatus('offline');
      return () => {
        alive = false;
      };
    }
    void (async () => {
      const ok = await client.health();
      if (!alive) return;
      if (!ok) {
        setDaemonStatus('offline');
        return;
      }
      setDaemonStatus('connected');
      try {
        const projects = await client.listProjects();
        if (!alive) return;
        // The most recently touched project is the one to reopen.
        const first = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        if (first === undefined) {
          setDaemonProjectId(null);
          setProject(null);
          setPublishes([]);
          setNotice({
            tone: 'info',
            text: 'SQLite 데몬에 연결되었습니다. 데몬 DB가 비어 있어 새 프로젝트로 시작합니다.',
          });
          return;
        }
        const detail = await client.readProject(first.id);
        if (!alive) return;
        setDaemonProjectId(detail.project.id);
        setProject(normalizeProject(detail.project));
        setPublishes(detail.records);
        setRevertable(detail.revert);
        setNotice({ tone: 'info', text: 'SQLite 데몬에 연결되어 로컬 DB를 정본으로 사용합니다.' });
      } catch (error) {
        if (!alive) return;
        setDaemonStatus('offline');
        setNotice({
          tone: 'error',
          text:
            error instanceof DaemonError
              ? error.message
              : '데몬에서 프로젝트를 읽지 못해 브라우저 모드로 전환했습니다.',
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [client]);

  useEffect(() => {
    if (project === null) return;
    if (daemonStatus === 'connected') return;
    const outcome = saveProject(project);
    if (!outcome.ok) setNotice({ tone: 'error', text: outcome.reason });
  }, [project, daemonStatus]);

  /**
   * The desktop shell's global shortcut pings; the browser build has no
   * `window.specstudio` and keeps the in-app 빠른 캡처 button as the only path.
   */
  useEffect(() => {
    const off = window.specstudio?.onQuickCapture?.(() => setInboxCaptureOpen(true));
    return () => off?.();
  }, []);

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    document.title = project?.screen
      ? `${project.screen.title} · spec-studio`
      : 'spec-studio — 화면 한 장으로 시작하는 기획';
  }, [project]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file !== null) {
            event.preventDefault();
            fileHandler.current(file);
          }
          return;
        }
      }
    };

    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files') === true) {
        event.preventDefault();
        setDragging(true);
      }
    };
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer?.files?.[0];
      if (file !== undefined) fileHandler.current(file);
    };

    window.addEventListener('paste', onPaste);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  const sqliteMode = daemonStatus === 'connected' && daemonProjectId !== null;

  /**
   * One path for both modes: with a daemon the command is applied by the store
   * in SQLite and the answer becomes the screen's state; without one it is
   * applied in the browser by the same core function.
   */
  const applyCommand = async (command: Command): Promise<ApplyResult | null> => {
    if (project === null) return null;
    if (sqliteMode && daemonProjectId !== null) {
      try {
        const outcome = await client.execute(daemonProjectId, command);
        const next = normalizeProject(outcome.project);
        setProject(next);
        return {
          project: next,
          events: outcome.events as DomainEvent[],
          opSeq: outcome.opSeq,
        };
      } catch (error) {
        setNotice({
          tone: 'error',
          text:
            error instanceof DaemonError
              ? error.message
              : error instanceof Error
                ? error.message
                : '명령을 적용하지 못했습니다.',
        });
        return null;
      }
    }

    const at = nowIso();
    try {
      const result = execute(project, command, { at, nextId });
      setProject(result.project);
      return result;
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : '명령을 적용하지 못했습니다.',
      });
      return null;
    }
  };

  const attachScreen = async (screen: Screen) => {
    const at = nowIso();
    if (project === null) {
      if (daemonStatus === 'connected') {
        try {
          const created = await client.createProject(screen.title);
          const result = await client.execute(created.id, { type: 'screen.attach', screen });
          setDaemonProjectId(created.id);
          setProject(normalizeProject(result.project));
          setPublishes([]);
          setDraftAnchor(null);
          setSelectedPinId(null);
          setGateError(null);
        } catch (error) {
          setGateError(
            error instanceof DaemonError ? error.message : '데몬에 프로젝트를 만들지 못했습니다.',
          );
        }
        return;
      }
      const created = createProject({ id: newProjectId(), name: screen.title, at });
      const result = execute(created, { type: 'screen.attach', screen }, { at, nextId });
      setProject(result.project);
      setDraftAnchor(null);
      setSelectedPinId(null);
      return;
    }
    if (
      project.screen !== null &&
      project.screen.id !== screen.id &&
      project.pins.length > 0 &&
      !window.confirm('새 화면을 열면 지금 화면의 핀 목록이 비워집니다. 계속할까요?')
    ) {
      return;
    }
    const result = await applyCommand({ type: 'screen.attach', screen });
    if (result !== null) {
      setSelectedPinId(null);
      setDraftAnchor(null);
      setFilter('all');
      setRevertable(null);
      setFocusBlockId(null);
    }
  };

  const attachFromFile = async (file: File) => {
    try {
      const image = await imageFromFile(file);
      const at = nowIso();
      const title = image.name.replace(/\.[^./\\]+$/, '').trim().slice(0, 40);
      await attachScreen({
        id: newScreenId(),
        title: title === '' ? '업로드한 화면' : title,
        code: 'SCR-101',
        ref: { kind: 'image', value: image.dataUrl, label: image.name },
        viewport: { width: image.width, height: image.height },
        createdAt: at,
        updatedAt: at,
      });
      setGateError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : '이미지를 열지 못했습니다.';
      if (project === null) setGateError(message);
      else setNotice({ tone: 'error', text: message });
    }
  };

  fileHandler.current = (file: File) => {
    void attachFromFile(file);
  };

  const openSample = () => {
    const at = nowIso();
    void attachScreen({
      id: newScreenId(),
      title: SAMPLE_TITLE,
      code: SAMPLE_CODE,
      ref: { kind: 'image', value: SAMPLE_IMAGE, label: '샘플 화면' },
      viewport: { width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT },
      createdAt: at,
      updatedAt: at,
    });
    setGateError(null);
  };

  const openFigma = (raw: string) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      setGateError('주소 형식을 확인해 주세요. https://www.figma.com/… 처럼 입력합니다.');
      return;
    }
    if (!/(^|\.)figma\.com$/.test(url.hostname)) {
      setGateError('Figma 주소(figma.com)만 등록할 수 있습니다.');
      return;
    }
    const at = nowIso();
    void attachScreen({
      id: newScreenId(),
      title: 'Figma 프레임',
      code: 'SCR-101',
      ref: { kind: 'figma_frame', value: url.toString() },
      viewport: null,
      createdAt: at,
      updatedAt: at,
    });
    setGateError(null);
  };

  const savePin = async (input: PinDraftInput) => {
    const screen = project?.screen ?? null;
    if (screen === null || draftAnchor === null) return;
    const result = await applyCommand({
      type: 'pin.create',
      screenId: screen.id,
      pinType: input.pinType,
      title: input.title,
      body: input.body,
      anchor: draftAnchor,
    });
    if (result === null) return;
    const created = result.events.find((event) => event.type === 'pin.created');
    if (created !== undefined && created.type === 'pin.created') {
      setSelectedPinId(created.pin.id);
    }
    setDraftAnchor(null);
    setFilter('all');
  };

  const deletePin = async (pin: Pin) => {
    const screen = project?.screen ?? null;
    if (screen === null) return;
    const result = await applyCommand({ type: 'pin.delete', screenId: screen.id, pinId: pin.id });
    if (result !== null && selectedPinId === pin.id) setSelectedPinId(null);
  };

  /** Editing a pin's type, title or body — the number is not in the command. */
  const updatePin = (pinId: string, input: PinEditInput) => {
    const screen = project?.screen ?? null;
    if (screen === null) return;
    void applyCommand({
      type: 'pin.update',
      screenId: screen.id,
      pinId,
      pinType: input.pinType,
      title: input.title,
      body: input.body,
    });
  };

  /** A drag on the image: same command, only the anchor changes. */
  const movePin = (pinId: string, anchor: Anchor) => {
    const screen = project?.screen ?? null;
    if (screen === null) return;
    void applyCommand({ type: 'pin.update', screenId: screen.id, pinId, anchor });
  };

  const saveFigmaUrl = (url: string | null) => {
    const screen = project?.screen ?? null;
    if (screen === null) return;
    void applyCommand({ type: 'screen.update', screenId: screen.id, figmaUrl: url });
  };

  /**
   * Document commands share one path. The store writes them in the same
   * transaction as the pins they read, so an adopted proposal and the
   * `op_log.before` that reverts it are never out of step.
   */
  const runDoc = async (command: Command, after?: (result: ApplyResult) => void) => {
    setBusy(true);
    try {
      const result = await applyCommand(command);
      if (result !== null) after?.(result);
    } finally {
      setBusy(false);
    }
  };

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
    void runDoc({ type: 'doc.block.update', docId: doc.id, blockId, text });
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
      setNotice({
        tone: 'info',
        text:
          revertable.kind === 'graph'
            ? `그래프 채택 ${outcome.revertedSeq}번을 되돌렸습니다. 객체 ${revertable.nodes}개와 그 링크를 제거했습니다.`
            : `채택 ${outcome.revertedSeq}번을 되돌렸습니다. 문단 ${outcome.blocks}개를 채택 직전 상태로 복원했습니다.`,
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

  const reset = async () => {
    if (!window.confirm('현재 화면과 핀을 모두 지우고 처음으로 돌아갑니다. 계속할까요?')) {
      return;
    }
    setSelectedPinId(null);
    setDraftAnchor(null);
    setFilter('all');
    setGateError(null);
    setOutputOpen(false);
    setPublishOpen(false);
    setRevertable(null);
    setDocMode('direct');
    if (daemonStatus === 'connected') {
      try {
        const created = await client.createProject('새 화면');
        setDaemonProjectId(created.id);
        setProject(normalizeProject(created));
        setPublishes([]);
      } catch (error) {
        setNotice({
          tone: 'error',
          text: error instanceof DaemonError ? error.message : '데몬에 새 프로젝트를 만들지 못했습니다.',
        });
      }
      return;
    }
    setProject(null);
    clearStoredProject();
  };

  /**
   * A bundle leaves through the daemon when one is connected, so what is saved
   * is what SQLite holds — not a browser copy that could lag a write.
   */
  const exportProject = async () => {
    if (project === null) return;
    if (sqliteMode && daemonProjectId !== null) {
      try {
        downloadBundle(await client.exportProject(daemonProjectId));
        setNotice({ tone: 'info', text: 'SQLite 프로젝트를 번들 JSON으로 내보냈습니다.' });
      } catch (error) {
        setNotice({
          tone: 'error',
          text: error instanceof DaemonError ? error.message : '번들을 내보내지 못했습니다.',
        });
      }
      return;
    }
    downloadBundle(bundleOf(project));
  };

  /** Import always becomes a new project; the one on screen is never overwritten. */
  const importProject = async (file: File) => {
    try {
      const bundle = parseBundleFile(await file.text());
      if (sqliteMode) {
        const created = await client.importBundle(bundle);
        setDaemonProjectId(created.id);
        setProject(normalizeProject(created));
        setPublishes([]);
        setRevertable(null);
        setSelectedPinId(null);
        setSelectedGraphId(null);
        setDraftAnchor(null);
        setFilter('all');
        setNotice({
          tone: 'info',
          text: `번들을 새 프로젝트 "${created.name}"(으)로 가져왔습니다. 객체 ${created.graph.nodes.length}개 · 링크 ${created.graph.links.length}개.`,
        });
        return;
      }
      setProject(bundle.project);
      setSelectedPinId(null);
      setSelectedGraphId(null);
      setDraftAnchor(null);
      setFilter('all');
      setNotice({ tone: 'info', text: '프로젝트 번들을 불러왔습니다.' });
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : 'JSON을 읽지 못했습니다.',
      });
    }
  };

  const backupProject = async () => {
    if (daemonProjectId === null) return;
    setBusy(true);
    try {
      const backup = await client.backup(daemonProjectId);
      setNotice({
        tone: 'info',
        text: `SQLite 스냅샷을 저장했습니다 · ${(backup.bytes / 1024).toFixed(1)}KB · ${backup.path}`,
      });
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof DaemonError ? error.message : '백업하지 못했습니다.',
      });
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    if (daemonProjectId === null) return;
    try {
      const detail = await client.readProject(daemonProjectId);
      setProject(normalizeProject(detail.project));
      setRevertable(detail.revert);
    } catch {
      // A reload is a convenience; the command answer already updated state.
    }
  };

  const createGraphProposal = () => {
    void runDoc({ type: 'graph.proposal.create' }, (result) => {
      const summary = result.project.graphProposal?.summary ?? '';
      setNotice({ tone: 'info', text: summary });
      setSelectedGraphId(null);
    });
  };

  const adoptGraphProposal = () => {
    const proposal = project?.graphProposal ?? null;
    if (proposal === null) return;
    void runDoc({ type: 'graph.proposal.adopt', proposalId: proposal.id }, (result) => {
      setNotice({
        tone: 'info',
        text: `초안 ${proposal.nodes.length}개와 링크 ${proposal.links.length}개를 만들었습니다.`,
      });
      if (result.opSeq !== undefined) {
        setRevertable({
          seq: result.opSeq,
          at: nowIso(),
          summary: proposal.summary,
          blocks: 0,
          kind: 'graph',
          op: 'graph.proposal.adopt',
          nodes: proposal.nodes.length,
          proposalId: proposal.id,
        });
      }
      setSelectedGraphId(null);
    });
  };

  const rejectGraphProposal = () => {
    const proposal = project?.graphProposal ?? null;
    if (proposal === null) return;
    void runDoc({ type: 'graph.proposal.reject', proposalId: proposal.id });
  };

  const refreshAiStatus = () => {
    void client
      .aiStatus()
      .then((status) => setAiStatus(status))
      .catch(() => setAiStatus(null));
  };

  /** The panel opens with the daemon's answer about which keys it already has. */
  const openAiPanel = () => {
    setAiOpen(true);
    setAiResult(null);
    if (daemonStatus === 'connected') refreshAiStatus();
  };

  const updateAiSettings = (patch: Partial<AiSettingsValue>) => {
    setAiSettings((current) => ({ ...current, ...patch }));
  };

  const aiRequest = () => ({
    provider: aiSettings.provider,
    presetId: aiSettings.presetId,
    model: aiSettings.model,
    endpoint: aiSettings.endpoint.trim() === '' ? null : aiSettings.endpoint.trim(),
    apiKey: aiSettings.apiKey,
  });

  const runAiTest = async () => {
    setAiBusy(true);
    setAiResult(null);
    try {
      const result = await client.aiTest(aiRequest());
      if (result.ok && aiSettings.saveToKeychain && aiSettings.apiKey.trim() !== '') {
        // Save is a one-way move: the field clears and the key is write-only.
        try {
          await client.aiKeychainStore({
            presetId: aiSettings.presetId,
            apiKey: aiSettings.apiKey.trim(),
          });
          setAiSettings((current) => ({ ...current, apiKey: '', saveToKeychain: false }));
          refreshAiStatus();
          setAiResult({
            tone: 'info',
            text: `연결 정상 · ${result.latencyMs}ms · 키체인에 저장했습니다`,
          });
          return;
        } catch (error) {
          setAiResult({
            tone: 'error',
            text:
              error instanceof DaemonError
                ? `연결은 되었지만 키체인 저장에 실패했습니다. ${error.message}`
                : '연결은 되었지만 키체인 저장에 실패했습니다.',
          });
          return;
        }
      }
      setAiResult({
        tone: result.ok ? 'info' : 'error',
        text: result.ok ? `연결 정상 · ${result.latencyMs}ms` : result.message,
      });
    } catch (error) {
      setAiResult({
        tone: 'error',
        text: error instanceof DaemonError ? error.message : '연결을 확인하지 못했습니다.',
      });
    } finally {
      setAiBusy(false);
    }
  };

  /** Write-only keychain: the app can use a stored key and delete it, never show it. */
  const runKeychainErase = async () => {
    setAiBusy(true);
    try {
      await client.aiKeychainErase({ presetId: aiSettings.presetId });
      refreshAiStatus();
      setAiResult({ tone: 'info', text: '키체인에서 삭제했습니다.' });
    } catch (error) {
      setAiResult({
        tone: 'error',
        text: error instanceof DaemonError ? error.message : '키체인에서 삭제하지 못했습니다.',
      });
    } finally {
      setAiBusy(false);
    }
  };

  /**
   * The model proposes; the card appears; nothing is written yet. `채택` is
   * still the only thing that changes the document or the graph, and the same
   * `되돌리기` takes it back.
   */
  const runAiProposal = async (mode: AiProposalMode) => {
    if (!sqliteMode || daemonProjectId === null) {
      setAiResult({ tone: 'error', text: 'SQLite 데몬 모드에서만 제안을 추출할 수 있습니다.' });
      return;
    }
    setAiBusy(true);
    setAiResult(null);
    try {
      // The card targets the doc on screen; graph mode has no doc of its own.
      const outcome = await client.aiProposal(daemonProjectId, {
        ...aiRequest(),
        mode,
        docId: mode === 'doc' && doc !== null ? doc.id : null,
      });
      setProject(normalizeProject(outcome.project));
      setAiSource(outcome.source);
      setAiResult({
        tone: outcome.source === 'llm' ? 'info' : 'error',
        text: outcome.note,
      });
      setNotice({ tone: 'info', text: outcome.note });
      setAiOpen(false);
      if (mode === 'graph') {
        setSelectedGraphId(null);
        setView('graph');
      } else {
        setDocMode('proposal');
      }
    } catch (error) {
      setAiResult({
        tone: 'error',
        text: error instanceof DaemonError ? error.message : '제안을 받지 못했습니다.',
      });
    } finally {
      setAiBusy(false);
    }
  };

  // ── idea inbox · research board (E1 §4 F2·F3) ────────────────────────

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
        // MN-2: a promoted spec never opens empty — the brief summary when
        // this session ran one for the idea, else the idea's own text.
        const seed = briefSeeds.current.get(idea.id) ?? idea.text;
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

  /**
   * The brief flow (F3-2): idea + evidence in, one decision card out. The
   * research doc is created first when the project has none — sequential
   * commands, because the command path is the only write path.
   */
  const runBrief = async (ideaId: string, evidenceIds: string[]) => {
    if (!sqliteMode || daemonProjectId === null) {
      setNotice({ tone: 'error', text: 'SQLite 데몬 모드에서만 브리프를 만들 수 있습니다.' });
      return;
    }
    setAiBusy(true);
    try {
      let targetDocId = docs.find((candidate) => candidate.kind === 'research')?.id ?? null;
      if (targetDocId === null) {
        const created = await applyCommand({
          type: 'doc.create',
          title: '리서치',
          kind: 'research',
        });
        if (created === null) return;
        const docCreated = created.events.find((event) => event.type === 'doc.created');
        if (docCreated === undefined || docCreated.type !== 'doc.created') return;
        targetDocId = docCreated.doc.id;
      }
      const outcome = await client.aiProposal(daemonProjectId, {
        ...aiRequest(),
        mode: 'brief',
        docId: targetDocId,
        ideaId,
        evidenceIds,
      });
      const next = normalizeProject(outcome.project);
      setProject(next);
      setAiSource(outcome.source);
      const filed = next.proposals.filter((candidate) => candidate.docId === targetDocId).at(-1);
      if (filed !== undefined) {
        setAiCardSource({ proposalId: filed.id, source: outcome.source });
        // MN-2: remember which idea this brief answered — 승격이 그 요약을
        // 새 스펙의 첫 문단으로 씁니다. idea↔proposal의 영속 링크가 없어
        // 세션 한정 기록입니다 (영속화는 proposal.idea_id 스키마 이월).
        briefSeeds.current.set(ideaId, filed.summary);
      }
      setAiResult({
        tone: outcome.source === 'llm' ? 'info' : 'error',
        text: outcome.note,
      });
      setNotice({ tone: 'info', text: outcome.note });
      setActiveDocId(targetDocId);
      setDocMode('proposal');
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof DaemonError ? error.message : '브리프를 받지 못했습니다.',
      });
    } finally {
      setAiBusy(false);
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

  const createGraphNode = (
    nodeType: 'req' | 'policy' | 'contract' | 'qa',
    title: string,
    body: string,
  ) => {
    void runDoc({ type: 'node.create', nodeType, title, body }, (result) => {
      setSelectedGraphId(result.project.graph.nodes.at(-1)?.id ?? null);
    });
  };

  const updateGraphNode = (
    nodeId: string,
    patch: { title?: string; body?: string; state?: string },
  ) => {
    void runDoc({ type: 'node.update', nodeId, ...patch });
  };

  const deleteGraphNode = (nodeId: string) => {
    void runDoc({ type: 'node.delete', nodeId }, () => {
      if (selectedGraphId === nodeId) setSelectedGraphId(null);
    });
  };

  const createGraphLink = (linkType: string, src: string, dst: string) => {
    void runDoc({ type: 'link.create', linkType, src, dst } as Command, () => void reload());
  };

  const deleteGraphLink = (linkId: string) => {
    void runDoc({ type: 'link.delete', linkId }, () => void reload());
  };

  const ackGraphLink = (linkId: string) => {
    void runDoc({ type: 'link.ack', linkId });
  };

  const screen = project?.screen ?? null;
  const pins = project?.pins ?? [];
  const maturity =
    project === null
      ? EMPTY_MATURITY
      : evaluateMaturityLevel(project, {
          published: publishes.some((record) => record.status === 'ok'),
        });
  const report = project === null ? null : traceability(project);
  const graphNodes = project === null ? [] : graphViewNodes(project);
  const nextNumber = (project?.pinSeq ?? 0) + 1;
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


  return (
    <div className="app">
      <TopBar
        screen={screen}
        daemonStatus={daemonStatus}
        view={view}
        maturity={maturity}
        onView={setView}
        onExport={() => void exportProject()}
        onImport={() => importInput.current?.click()}
        onBackup={() => void backupProject()}
        onReset={() => void reset()}
        onOpenOutputs={() => setOutputOpen(true)}
        onOpenPublish={() => setPublishOpen(true)}
        onOpenAi={openAiPanel}
        aiSource={aiSource}
      />

      {aiOpen && (
        <AiSettingsModal
          value={aiSettings}
          status={aiStatus}
          busy={aiBusy}
          result={aiResult}
          hasDoc={doc !== null}
          sqliteMode={sqliteMode}
          onChange={updateAiSettings}
          onTest={() => void runAiTest()}
          onEraseKeychain={() => void runKeychainErase()}
          onPropose={(mode) => void runAiProposal(mode)}
          onClose={() => setAiOpen(false)}
        />
      )}

      <input
        ref={importInput}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) void importProject(file);
          event.target.value = '';
        }}
      />

      {daemonStatus === 'checking' ? (
        <div className="boot-screen" data-testid="boot">
          <span className="boot-mark" aria-hidden="true" />
          로컬 SQLite 데몬(127.0.0.1)을 확인하는 중…
        </div>
      ) : screen !== null && project !== null && view === 'graph' && report !== null ? (
        <GraphView
          project={project}
          nodes={graphNodes}
          report={report}
          maturity={maturity}
          busy={busy}
          selectedId={selectedGraphId}
          revertable={
            revertable === null
              ? null
              : { seq: revertable.seq, summary: revertable.summary, nodes: revertable.nodes }
          }
          onSelect={setSelectedGraphId}
          onCreateNode={createGraphNode}
          onUpdateNode={updateGraphNode}
          onDeleteNode={deleteGraphNode}
          onCreateLink={createGraphLink}
          onDeleteLink={deleteGraphLink}
          onAckLink={ackGraphLink}
          onProposal={createGraphProposal}
          onAdopt={adoptGraphProposal}
          onReject={rejectGraphProposal}
          onRevert={() => void revertAdopted()}
        />
      ) : screen !== null && project !== null ? (
        <main
          className={`studio${doc !== null && doc.kind === 'research' ? ' studio--research' : ''}`}
        >
          <section className="canvas-column">
            <div className="canvas-tools">
              <span className="tool-label">Screen</span>
              <span className="tool-meta">
                {screen.code}
                {screen.viewport !== null
                  ? ` · ${screen.viewport.width}×${screen.viewport.height}`
                  : ' · Figma'}
              </span>
              <button
                type="button"
                className="btn btn--sm tool-action"
                onClick={() => {
                  setDraftAnchor({ x: 0.5, y: 0.5 });
                  setSelectedPinId(null);
                }}
              >
                핀 추가
              </button>
              <span className="tool-hint">이미지 클릭 → 번호 핀</span>
            </div>

            <FigmaBar screen={screen} onSave={saveFigmaUrl} />

            <CanvasStage
              screen={screen}
              pins={pins}
              selectedPinId={selectedPinId}
              draft={draftAnchor}
              nextNumber={nextNumber}
              onCanvasClick={(anchor) => {
                setDraftAnchor(anchor);
                setSelectedPinId(null);
              }}
              onSelectPin={setSelectedPinId}
              onMovePin={movePin}
              onSavePin={(input) => void savePin(input)}
              onCancelDraft={() => setDraftAnchor(null)}
            />

            <div className="canvas-foot">
              <span>
                {sqliteMode
                  ? '모든 변경은 로컬 SQLite 파일에 즉시 저장됩니다.'
                  : '모든 변경은 이 브라우저에만 저장됩니다.'}
              </span>
              <span className="mono">
                {pins.length} pins · next #{nextNumber}
              </span>
            </div>
          </section>

          <DocPanel
            doc={doc}
            docs={docs}
            pins={pins}
            proposal={proposal}
            mode={docMode}
            selectedPinId={selectedPinId}
            focusBlockId={focusBlockId}
            revertable={revertable}
            ungrounded={ungroundedReqs}
            sourceHint={aiCardSource}
            sqliteMode={sqliteMode}
            busy={busy}
            onMode={setDocMode}
            onSwitchDoc={setActiveDocId}
            onCreateDoc={createDoc}
            onDeleteDoc={deleteDoc}
            onAddBlock={addBlock}
            onUpdateText={updateBlockText}
            onChangeType={changeBlockType}
            onDeleteBlock={deleteBlock}
            onMoveBlock={moveBlock}
            onLinkPin={linkBlockPin}
            onUnlinkPin={unlinkBlockPin}
            onClearStale={clearStale}
            onSelectPin={setSelectedPinId}
            onCreateProposal={createProposal}
            onAdopt={() => decideProposal('adopt')}
            onReject={() => decideProposal('reject')}
            onRevert={() => void revertAdopted()}
            onFocusHandled={() => setFocusBlockId(null)}
          />

          {doc !== null && doc.kind === 'research' && (
            <EvidencePanel
              evidence={project.evidence}
              requirements={reqOptions}
              busy={busy}
              onCapture={captureEvidence}
              onDismiss={dismissEvidence}
              onLink={linkEvidence}
            />
          )}

          <div className="side-rail">
            <PinPanel
              doc={doc}
              onFocusBlock={setFocusBlockId}
              pins={pins}
              filter={filter}
              screenCode={screen.code}
              nextNumber={nextNumber}
              pinSeq={project.pinSeq}
              selectedPinId={selectedPinId}
              onFilter={setFilter}
              onSelect={setSelectedPinId}
              onDelete={(pin) => void deletePin(pin)}
              onUpdate={updatePin}
              onCloseEditor={() => setSelectedPinId(null)}
            />

            <IdeaInboxPanel
              ideas={project.ideas}
              evidence={project.evidence}
              busy={busy}
              briefBusy={aiBusy}
              sqliteMode={sqliteMode}
              captureOpen={inboxCaptureOpen}
              onOpenCapture={() => setInboxCaptureOpen(true)}
              onCloseCapture={() => setInboxCaptureOpen(false)}
              onCapture={captureIdea}
              onArchive={archiveIdea}
              onPromote={(idea) => void promoteIdea(idea)}
              onRunBrief={(ideaId, evidenceIds) => void runBrief(ideaId, evidenceIds)}
            />
          </div>
        </main>
      ) : (
        <EntryGate
          error={gateError}
          onSample={openSample}
          onFile={(file) => {
            void attachFromFile(file);
          }}
          onFigma={openFigma}
        />
      )}

      {dragging && <div className="drop-veil">이미지를 놓으면 화면으로 등록됩니다</div>}
      {outputOpen && screen !== null && project !== null && (
        <OutputModal
          screen={screen}
          pins={pins}
          pinSeq={project.pinSeq}
          doc={specDoc}
          project={project}
          onExportPackage={async (files) => {
            await applyCommand({ type: 'project.package.export', files });
          }}
          onClose={() => setOutputOpen(false)}
        />
      )}
      {publishOpen &&
        screen !== null &&
        project !== null &&
        daemonProjectId !== null &&
        daemonStatus === 'connected' && (
          <PublishModal
            projectId={daemonProjectId}
            screen={screen}
            pins={pins}
            daemon={client}
            records={publishes}
            onRecords={setPublishes}
            onClose={() => setPublishOpen(false)}
          />
        )}
      {notice !== null && (
        <div className={`toast${notice.tone === 'error' ? ' toast--error' : ''}`} role="status">
          {notice.text}
        </div>
      )}
    </div>
  );
}
