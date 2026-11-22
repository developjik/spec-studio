import { useRef, useState } from 'react';
import { normalizeProject } from '@spec-studio/core';
import type { Project } from '@spec-studio/protocol';
import type { PinFilter } from '@spec-studio/core';
import {
  DaemonClient,
  DaemonError,
  type PublishRecordView,
  type RevertableView,
} from '../model/daemon';
import {
  bundleOf,
  downloadBundle,
  parseBundleFile,
} from '../model/storage';
import type { Notice } from '../model/appUtils';

/**
 * 출력/발행 영역: the output and publish modals, and the file surfaces —
 * bundle export, import (always a new project, never an overwrite) and the
 * SQLite snapshot backup.
 */
export function useOutputs({
  client,
  project,
  sqliteMode,
  daemonProjectId,
  setDaemonProjectId,
  setProject,
  setPublishes,
  setRevertable,
  setSelectedPinId,
  setSelectedGraphId,
  setDraftAnchor,
  setFilter,
  setBusy,
  setNotice,
}: {
  client: DaemonClient;
  project: Project | null;
  sqliteMode: boolean;
  daemonProjectId: string | null;
  setDaemonProjectId: (id: string) => void;
  setProject: (project: Project) => void;
  setPublishes: (records: PublishRecordView[]) => void;
  setRevertable: (revertable: RevertableView | null) => void;
  setSelectedPinId: (id: string | null) => void;
  setSelectedGraphId: (id: string | null) => void;
  setDraftAnchor: (anchor: null) => void;
  setFilter: (filter: PinFilter) => void;
  setBusy: (busy: boolean) => void;
  setNotice: (notice: Notice | null) => void;
}) {
  const [outputOpen, setOutputOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);

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

  return {
    outputOpen,
    setOutputOpen,
    publishOpen,
    setPublishOpen,
    importInput,
    exportProject,
    importProject,
    backupProject,
  };
}
