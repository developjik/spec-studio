import { useEffect, useRef, useState } from 'react';
import { createProject, execute, normalizeProject, type ExecutionResult } from '@spec-studio/core';
import type {
  Anchor,
  Command,
  DomainEvent,
  Pin,
  Project,
  Screen,
} from '@spec-studio/protocol';
import type { PinFilter } from '@spec-studio/core';
import { TopBar } from './components/TopBar';
import { EntryGate } from './components/EntryGate';
import { CanvasStage } from './components/CanvasStage';
import { PinPanel } from './components/PinPanel';
import type { PinDraftInput } from './components/PinComposer';
import type { PinEditInput } from './components/PinEditor';
import { OutputModal } from './components/OutputModal';
import { PublishModal } from './components/PublishModal';
import { FigmaBar } from './components/FigmaBar';
import { newPinId, newProjectId, newScreenId } from './model/ids';
import {
  clearStoredProject,
  downloadProject,
  loadProject,
  parseProjectFile,
  saveProject,
} from './model/storage';
import { imageFromFile } from './model/image';
import {
  DaemonClient,
  DaemonError,
  type DaemonStatus,
  type PublishRecordView,
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
const nextId = (kind: 'screen' | 'pin') => (kind === 'screen' ? newScreenId() : newPinId());

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
  const importInput = useRef<HTMLInputElement>(null);
  const fileHandler = useRef<(file: File) => void>(() => undefined);

  /** On boot: if the loopback daemon answers, SQLite becomes the source of truth. */
  useEffect(() => {
    let alive = true;
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
  const applyCommand = async (command: Command): Promise<ExecutionResult | null> => {
    if (project === null) return null;
    if (sqliteMode && daemonProjectId !== null) {
      try {
        const outcome = await client.execute(daemonProjectId, command);
        const next = normalizeProject(outcome.project);
        setProject(next);
        return { project: next, events: outcome.events as DomainEvent[] };
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

  const importProject = async (file: File) => {
    if (daemonStatus === 'connected') {
      setNotice({
        tone: 'info',
        text: 'SQLite 데몬 연결 중에는 JSON 불러오기를 지원하지 않습니다. 데몬 DB가 정본입니다.',
      });
      return;
    }
    try {
      const text = await file.text();
      const imported = parseProjectFile(text);
      setProject(imported);
      setSelectedPinId(null);
      setDraftAnchor(null);
      setFilter('all');
      setNotice({ tone: 'info', text: '프로젝트를 불러왔습니다.' });
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : 'JSON을 읽지 못했습니다.',
      });
    }
  };

  const screen = project?.screen ?? null;
  const pins = project?.pins ?? [];
  const nextNumber = (project?.pinSeq ?? 0) + 1;

  return (
    <div className="app">
      <TopBar
        screen={screen}
        daemonStatus={daemonStatus}
        onExport={() => {
          if (project !== null) downloadProject(project);
        }}
        onImport={() => importInput.current?.click()}
        onReset={() => void reset()}
        onOpenOutputs={() => setOutputOpen(true)}
        onOpenPublish={() => setPublishOpen(true)}
      />

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
      ) : screen !== null && project !== null ? (
        <main className="studio">
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

          <PinPanel
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
