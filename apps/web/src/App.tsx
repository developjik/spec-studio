import { useEffect, useRef, useState } from 'react';
import { createProject, execute, type ExecutionResult } from '@spec-studio/core';
import type {
  Anchor,
  Command,
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
  const [project, setProject] = useState<Project | null>(() => loadProject());
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [filter, setFilter] = useState<PinFilter>('all');
  const [draftAnchor, setDraftAnchor] = useState<Anchor | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const fileHandler = useRef<(file: File) => void>(() => undefined);

  useEffect(() => {
    if (project === null) return;
    const outcome = saveProject(project);
    if (!outcome.ok) setNotice({ tone: 'error', text: outcome.reason });
  }, [project]);

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

  const applyCommand = (command: Command): ExecutionResult | null => {
    if (project === null) return null;
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

  const attachScreen = (screen: Screen) => {
    const at = nowIso();
    if (project === null) {
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
    const result = applyCommand({ type: 'screen.attach', screen });
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
      const title = image.name.replace(/\.[^.\\/]+$/, '').trim().slice(0, 40);
      attachScreen({
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
    attachScreen({
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
    attachScreen({
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

  const savePin = (input: PinDraftInput) => {
    const screen = project?.screen ?? null;
    if (screen === null || draftAnchor === null) return;
    const result = applyCommand({
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

  const deletePin = (pin: Pin) => {
    const screen = project?.screen ?? null;
    if (screen === null) return;
    const result = applyCommand({ type: 'pin.delete', screenId: screen.id, pinId: pin.id });
    if (result !== null && selectedPinId === pin.id) setSelectedPinId(null);
  };

  const reset = () => {
    if (
      !window.confirm('현재 화면과 핀을 모두 지우고 처음으로 돌아갑니다. 계속할까요?')
    ) {
      return;
    }
    setProject(null);
    setSelectedPinId(null);
    setDraftAnchor(null);
    setFilter('all');
    setGateError(null);
    clearStoredProject();
  };

  const importProject = async (file: File) => {
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
        onExport={() => {
          if (project !== null) downloadProject(project);
        }}
        onImport={() => importInput.current?.click()}
        onReset={reset}
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

      {screen !== null && project !== null ? (
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
              onSavePin={savePin}
              onCancelDraft={() => setDraftAnchor(null)}
            />

            <div className="canvas-foot">
              <span>모든 변경은 이 브라우저에만 저장됩니다.</span>
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
            selectedPinId={selectedPinId}
            onFilter={setFilter}
            onSelect={setSelectedPinId}
            onDelete={deletePin}
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
      {notice !== null && (
        <div className={`toast${notice.tone === 'error' ? ' toast--error' : ''}`} role="status">
          {notice.text}
        </div>
      )}
    </div>
  );
}
