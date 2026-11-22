import { useEffect, useRef, useState } from 'react';
import { execute, normalizeProject } from '@spec-studio/core';
import type { Command, DomainEvent, Project } from '@spec-studio/protocol';
import {
  DaemonClient,
  DaemonError,
  daemonProbeAllowed,
  type DaemonStatus,
  type PublishRecordView,
  type RevertableView,
} from '../model/daemon';
import { loadProject, saveProject } from '../model/storage';
import { nextId, nowIso, type ApplyResult, type Notice } from '../model/appUtils';

/**
 * 데몬 연결/프로젝트 라이프사이클 영역: the loopback daemon owns the SQLite
 * 정본 when it answers; without it the browser keeps the project itself.
 * Everything that writes goes through `applyCommand` — one path for both
 * modes so the screen never forks on storage.
 */
export function useDaemonProject({
  setNotice,
}: {
  setNotice: (notice: Notice | null) => void;
}) {
  const client = useRef(new DaemonClient()).current;
  const [project, setProject] = useState<Project | null>(() => loadProject());
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatus>('checking');
  const [daemonProjectId, setDaemonProjectId] = useState<string | null>(null);
  const [publishes, setPublishes] = useState<PublishRecordView[]>([]);
  const [revertable, setRevertable] = useState<RevertableView | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * F-1: daemon commands run strictly in order. A blur-commit racing the
   * click it was caused by must never answer after it — an older `project`
   * landing last would erase the click's effect from the screen.
   */
  const commandQueue = useRef<Promise<void>>(Promise.resolve());

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
  }, [client, setNotice]);

  useEffect(() => {
    if (project === null) return;
    if (daemonStatus === 'connected') return;
    const outcome = saveProject(project);
    if (!outcome.ok) setNotice({ tone: 'error', text: outcome.reason });
  }, [project, daemonStatus, setNotice]);

  useEffect(() => {
    document.title = project?.screen
      ? `${project.screen.title} · spec-studio`
      : 'spec-studio — 화면 한 장으로 시작하는 기획';
  }, [project]);

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
        const queued = commandQueue.current.then(() => client.execute(daemonProjectId, command));
        commandQueue.current = queued.then(() => undefined, () => undefined);
        const outcome = await queued;
        const next = normalizeProject(outcome.project);
        setProject(next);
        // F-2: the execute answer names the undo the ledger now offers, so
        // the chip moves with the command instead of waiting for a reload.
        setRevertable(outcome.revert);
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

  return {
    client,
    project,
    setProject,
    daemonStatus,
    setDaemonStatus,
    daemonProjectId,
    setDaemonProjectId,
    publishes,
    setPublishes,
    revertable,
    setRevertable,
    busy,
    setBusy,
    sqliteMode,
    applyCommand,
    runDoc,
    reload,
  };
}
