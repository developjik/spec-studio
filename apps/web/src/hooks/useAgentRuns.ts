import { useEffect, useRef, useState } from 'react';
import type { Command, Doc, RunRecord } from '@spec-studio/protocol';
import { RUN_TERMINAL, upsertRun } from '../model/runview';
import {
  DaemonClient,
  type AiStatusView,
  type RunLogLineView,
} from '../model/daemon';
import type { ApplyResult, Notice } from '../model/appUtils';

/**
 * 에이전트 런 영역 (E3): the run surface — the project's runs, the one being
 * watched, its journal as the SSE stream appends — plus start/cancel/resume/
 * answer and the op stream that keeps the screen honest when a card files.
 */
export function useAgentRuns({
  client,
  sqliteMode,
  daemonProjectId,
  applyCommand,
  reload,
  refreshAiStatus,
  docs,
  aiStatus,
  setBusy,
  setNotice,
}: {
  client: DaemonClient;
  sqliteMode: boolean;
  daemonProjectId: string | null;
  applyCommand: (command: Command) => Promise<ApplyResult | null>;
  reload: () => Promise<void>;
  refreshAiStatus: () => void;
  docs: readonly Doc[];
  aiStatus: AiStatusView | null;
  setBusy: (busy: boolean) => void;
  setNotice: (notice: Notice | null) => void;
}) {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runLog, setRunLog] = useState<RunLogLineView[]>([]);
  const runStream = useRef<AbortController | null>(null);

  /**
   * AC-9: one stream per watched run. A new pick aborts the old reader — the
   * daemon's snapshot is the resync, so a stale event can never paint over a
   * newer run's state.
   */
  const watchRun = (runId: string) => {
    if (daemonProjectId === null) return;
    runStream.current?.abort();
    const controller = new AbortController();
    runStream.current = controller;
    setActiveRunId(runId);
    setRunLog([]);
    void client
      .streamRun(daemonProjectId, runId, (event) => {
        if (event.type === 'snapshot') {
          setRuns((current) => upsertRun(current, event.run));
          setRunLog(event.log);
        } else if (event.type === 'run') {
          setRuns((current) => upsertRun(current, event.run));
          // QA R3: a card files server-side and retires the proposal this
          // screen still shows — the moment the run reaches review, the
          // project (and the panel's card) must catch up, or a stale adopt
          // button 400s on a proposal that is no longer on the table.
          if (event.run.state === 'review') void reload();
        } else if (event.type === 'log') {
          setRunLog((current) => [...current, { stream: event.stream, line: event.line }]);
        }
      }, controller.signal)
      .catch(() => {
        // A dropped stream is progress lost, not state: the detail route
        // still answers on demand, so the panel degrades to its snapshot.
      });
  };

  /** Open the run list when the daemon project lands; watch the live one. */
  useEffect(() => {
    if (!sqliteMode || daemonProjectId === null) return;
    let alive = true;
    void client
      .listRuns(daemonProjectId)
      .then((list) => {
        if (!alive) return;
        setRuns(list);
        refreshAiStatus();
        const live = [...list].reverse().find((run) => !RUN_TERMINAL.has(run.state));
        const pick = live ?? list.at(-1);
        if (pick !== undefined) watchRun(pick.id);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // watchRun reads daemonProjectId — same deps, one subscription per project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sqliteMode, daemonProjectId]);

  /** Leaving the app — or the project — closes the open reader. */
  useEffect(() => () => runStream.current?.abort(), [daemonProjectId]);

  /**
   * F1: a card any run files — watched or not — must reach this screen. The
   * project's op stream is the refresh trigger; a burst of ops collapses
   * into one trailing reload, and the run list catches up on the same beat,
   * so a retired proposal's adopt button can never sit on a stale panel.
   */
  useEffect(() => {
    if (!sqliteMode || daemonProjectId === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    void client
      .streamProjectOps(
        daemonProjectId,
        () => {
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            void reload();
            void client.listRuns(daemonProjectId).then(setRuns).catch(() => undefined);
          }, 120);
        },
        controller.signal,
      )
      .catch(() => {
        // the op stream is a convenience: without it the panel still has the
        // per-run stream's review reload — degradation, never an error wall.
      });
    return () => {
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    };
    // reload/setRuns keep their shape for this project; one subscription here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sqliteMode, daemonProjectId]);

  /**
   * E3: an idea becomes a researcher run's task. The research doc is created
   * first when the project has none — the run's card files itself there.
   */
  const startAgentRun = async (ideaId: string) => {
    if (!sqliteMode || daemonProjectId === null) {
      setNotice({ tone: 'error', text: '에이전트 런은 SQLite 데몬 모드에서만 동작합니다.' });
      return;
    }
    setBusy(true);
    try {
      if (!docs.some((candidate) => candidate.kind === 'research')) {
        const created = await applyCommand({ type: 'doc.create', title: '리서치', kind: 'research' });
        if (created === null) return;
      }
      const result = await applyCommand({
        type: 'run.start',
        taskId: ideaId,
        agent: 'researcher',
        mode: 'research',
      });
      if (result === null) return;
      const started = result.events.find((event) => event.type === 'run.started');
      if (started !== undefined && started.type === 'run.started') {
        watchRun(started.run.id);
      }
      setNotice({ tone: 'info', text: '에이전트 런을 시작했습니다.' });
    } finally {
      setBusy(false);
    }
  };

  /** AC-9's cancel: one command — the daemon's abort lands in the same tick. */
  const cancelRun = (runId: string) => {
    void applyCommand({ type: 'run.cancel', runId });
  };

  const resumeRun = (runId: string) => {
    void applyCommand({ type: 'run.resume', runId });
  };

  /** A1: the panel only renders the field under needs_input; this is the belt. */
  const answerRun = (runId: string, text: string) => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    void applyCommand({ type: 'run.answer', runId, text: trimmed });
  };

  /**
   * The run's label says what a new turn would call: the first provider with
   * a key, exactly the daemon's own pick order. No key — the badge says so,
   * because the run will honestly fail (no silent fallback).
   */
  const runProvider = aiStatus?.providers.find(
    (provider) => provider.provider !== 'local' && provider.hasEnvKey,
  );
  const runModelLabel =
    runProvider !== undefined
      ? `${runProvider.provider} · ${runProvider.defaultModel}`
      : aiStatus === null
        ? null
        : '모델 키 없음 — 런은 중단되고 대기로 남습니다(키 설정 후 재개 가능)';

  return {
    runs,
    activeRunId,
    runLog,
    runModelLabel,
    watchRun,
    startAgentRun,
    cancelRun,
    resumeRun,
    answerRun,
  };
}
