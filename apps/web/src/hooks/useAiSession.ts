import { useState } from 'react';
import { normalizeProject } from '@spec-studio/core';
import type {
  AiProposalMode,
  AiProposalSource,
  Command,
  Doc,
  Project,
} from '@spec-studio/protocol';
import type { DocMode } from '../components/DocPanel';
import type { StudioView } from '../components/TopBar';
import type { AiPanelResult, AiSettingsValue } from '../components/AiSettingsModal';
import {
  DaemonClient,
  DaemonError,
  type AiStatusView,
  type DaemonStatus,
  type RevertableView,
} from '../model/daemon';
import type { ApplyResult, Notice } from '../model/appUtils';

/**
 * 설정/키 + AI 제안 영역: the settings modal's session-only values (the key
 * never leaves memory), the daemon's provider status, and the proposal
 * flows — doc/graph 제안 and the F3-2 brief — that file cards through the
 * daemon into the project.
 */
export function useAiSession({
  client,
  daemonStatus,
  sqliteMode,
  daemonProjectId,
  applyCommand,
  setProject,
  setRevertable,
  doc,
  docs,
  setDocMode,
  setActiveDocId,
  setView,
  setSelectedGraphId,
  setNotice,
}: {
  client: DaemonClient;
  daemonStatus: DaemonStatus;
  sqliteMode: boolean;
  daemonProjectId: string | null;
  applyCommand: (command: Command) => Promise<ApplyResult | null>;
  setProject: (project: Project) => void;
  setRevertable: (revertable: RevertableView | null) => void;
  doc: Doc | null;
  docs: readonly Doc[];
  setDocMode: (mode: DocMode) => void;
  setActiveDocId: (docId: string) => void;
  setView: (view: StudioView) => void;
  setSelectedGraphId: (id: string | null) => void;
  setNotice: (notice: Notice | null) => void;
}) {
  const [aiOpen, setAiOpen] = useState(false);
  const [aiStatus, setAiStatus] = useState<AiStatusView | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<AiPanelResult | null>(null);
  const [aiSource, setAiSource] = useState<AiProposalSource | null>(null);
  const [aiCardSource, setAiCardSource] = useState<{
    proposalId: string;
    source: AiProposalSource;
  } | null>(null);
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
      setRevertable(outcome.revert);
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
      setRevertable(outcome.revert);
      setAiSource(outcome.source);
      const filed = next.proposals.filter((candidate) => candidate.docId === targetDocId).at(-1);
      if (filed !== undefined) {
        setAiCardSource({ proposalId: filed.id, source: outcome.source });
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

  return {
    aiOpen,
    setAiOpen,
    aiStatus,
    aiBusy,
    aiResult,
    setAiResult,
    aiSource,
    aiCardSource,
    aiSettings,
    updateAiSettings,
    refreshAiStatus,
    openAiPanel,
    runAiTest,
    runKeychainErase,
    runAiProposal,
    runBrief,
  };
}
