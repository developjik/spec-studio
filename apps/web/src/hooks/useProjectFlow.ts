import {
  createProject,
  execute,
  normalizeProject,
} from '@spec-studio/core';
import type { Command, Project, Screen } from '@spec-studio/protocol';
import type { PinFilter } from '@spec-studio/core';
import type { DocMode } from '../components/DocPanel';
import {
  DaemonClient,
  DaemonError,
  type DaemonStatus,
  type PublishRecordView,
  type RevertableView,
} from '../model/daemon';
import { clearStoredProject } from '../model/storage';
import { imageFromFile } from '../model/image';
import { newProjectId, newScreenId } from '../model/ids';
import {
  SAMPLE_CODE,
  SAMPLE_HEIGHT,
  SAMPLE_IMAGE,
  SAMPLE_TITLE,
  SAMPLE_WIDTH,
} from '../model/sample';
import { parseFigmaUrl } from '../model/figmaUrl';
import { nextId, nowIso, type ApplyResult, type Notice } from '../model/appUtils';

/**
 * 프로젝트 라이프사이클의 진입/퇴장: attaching a screen (file, sample, Figma)
 * and the full reset. These orchestrate across domains — they clear the
 * other hooks' transient selections by the setters the App wires in.
 */
export function useProjectFlow({
  client,
  project,
  daemonStatus,
  applyCommand,
  setDaemonProjectId,
  setProject,
  setPublishes,
  setRevertable,
  setSelectedPinId,
  setDraftAnchor,
  setFilter,
  setFocusBlockId,
  setDocMode,
  setOutputOpen,
  setPublishOpen,
  setGateError,
  setNotice,
}: {
  client: DaemonClient;
  project: Project | null;
  daemonStatus: DaemonStatus;
  applyCommand: (command: Command) => Promise<ApplyResult | null>;
  setDaemonProjectId: (id: string) => void;
  setProject: (project: Project | null) => void;
  setPublishes: (records: PublishRecordView[]) => void;
  setRevertable: (revertable: RevertableView | null) => void;
  setSelectedPinId: (id: string | null) => void;
  setDraftAnchor: (anchor: null) => void;
  setFilter: (filter: PinFilter) => void;
  setFocusBlockId: (id: string | null) => void;
  setDocMode: (mode: DocMode) => void;
  setOutputOpen: (open: boolean) => void;
  setPublishOpen: (open: boolean) => void;
  setGateError: (error: string | null) => void;
  setNotice: (notice: Notice | null) => void;
}) {
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
    const url = parseFigmaUrl(raw);
    if (url === null) {
      setGateError('Figma 주소는 HTTPS를 사용하고 figma.com 도메인이어야 합니다.');
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

  return { attachScreen, attachFromFile, openSample, openFigma, reset };
}
