import {
  evaluateMaturityLevel,
  graphViewNodes,
  traceability,
} from '@spec-studio/core';
import { TopBar } from './components/TopBar';
import { GraphView } from './components/GraphView';
import { EntryGate } from './components/EntryGate';
import { CanvasStage } from './components/CanvasStage';
import { PinPanel } from './components/PinPanel';
import { IdeaInboxPanel } from './components/IdeaInboxPanel';
import { EvidencePanel } from './components/EvidencePanel';
import { OutputModal } from './components/OutputModal';
import { PublishModal } from './components/PublishModal';
import { FigmaBar } from './components/FigmaBar';
import { AiSettingsModal } from './components/AiSettingsModal';
import { DocPanel } from './components/DocPanel';
import { RunPanel } from './components/RunPanel';
import { useNotices } from './hooks/useNotices';
import { useDaemonProject } from './hooks/useDaemonProject';
import { useDocRegistry } from './hooks/useDocRegistry';
import { useGraphRtm } from './hooks/useGraphRtm';
import { useCanvasPins } from './hooks/useCanvasPins';
import { useIdeaInbox } from './hooks/useIdeaInbox';
import { useAiSession } from './hooks/useAiSession';
import { useAgentRuns } from './hooks/useAgentRuns';
import { useOutputs } from './hooks/useOutputs';
import { useProjectFlow } from './hooks/useProjectFlow';
import { EMPTY_MATURITY } from './model/appUtils';
import { surfaceProps } from './model/surfaces';

/**
 * Composition root (E4 F0): every domain lives in its hook — 데몬·프로젝트,
 * 문서, 그래프, 핀, 인박스, AI, 런, 출력 — and this file only wires them
 * together and lays out the surfaces.
 */
export default function App() {
  const notices = useNotices();
  const session = useDaemonProject({ setNotice: notices.setNotice });
  const docsApi = useDocRegistry({
    client: session.client,
    project: session.project,
    setProject: session.setProject,
    daemonProjectId: session.daemonProjectId,
    applyCommand: session.applyCommand,
    runDoc: session.runDoc,
    setBusy: session.setBusy,
    revertable: session.revertable,
    setRevertable: session.setRevertable,
    setNotice: notices.setNotice,
  });
  const graph = useGraphRtm({
    project: session.project,
    runDoc: session.runDoc,
    reload: session.reload,
    setRevertable: session.setRevertable,
    setNotice: notices.setNotice,
  });
  const pinsApi = useCanvasPins({
    project: session.project,
    applyCommand: session.applyCommand,
  });
  const inbox = useIdeaInbox({
    project: session.project,
    applyCommand: session.applyCommand,
    runDoc: session.runDoc,
    reload: session.reload,
    setBusy: session.setBusy,
    setActiveDocId: docsApi.setActiveDocId,
    setNotice: notices.setNotice,
  });
  const ai = useAiSession({
    client: session.client,
    daemonStatus: session.daemonStatus,
    sqliteMode: session.sqliteMode,
    daemonProjectId: session.daemonProjectId,
    applyCommand: session.applyCommand,
    setProject: session.setProject,
    setRevertable: session.setRevertable,
    doc: docsApi.doc,
    docs: docsApi.docs,
    setDocMode: docsApi.setDocMode,
    setActiveDocId: docsApi.setActiveDocId,
    setView: graph.setView,
    setSelectedGraphId: graph.setSelectedGraphId,
    setNotice: notices.setNotice,
  });
  const runsApi = useAgentRuns({
    client: session.client,
    sqliteMode: session.sqliteMode,
    daemonProjectId: session.daemonProjectId,
    applyCommand: session.applyCommand,
    reload: session.reload,
    refreshAiStatus: ai.refreshAiStatus,
    docs: docsApi.docs,
    aiStatus: ai.aiStatus,
    setBusy: session.setBusy,
    setNotice: notices.setNotice,
  });
  const outputs = useOutputs({
    client: session.client,
    project: session.project,
    sqliteMode: session.sqliteMode,
    daemonProjectId: session.daemonProjectId,
    setDaemonProjectId: session.setDaemonProjectId,
    setProject: session.setProject,
    setPublishes: session.setPublishes,
    setRevertable: session.setRevertable,
    setSelectedPinId: pinsApi.setSelectedPinId,
    setSelectedGraphId: graph.setSelectedGraphId,
    setDraftAnchor: pinsApi.setDraftAnchor,
    setFilter: pinsApi.setFilter,
    setBusy: session.setBusy,
    setNotice: notices.setNotice,
  });
  const flow = useProjectFlow({
    client: session.client,
    project: session.project,
    daemonStatus: session.daemonStatus,
    applyCommand: session.applyCommand,
    setDaemonProjectId: session.setDaemonProjectId,
    setProject: session.setProject,
    setPublishes: session.setPublishes,
    setRevertable: session.setRevertable,
    setSelectedPinId: pinsApi.setSelectedPinId,
    setDraftAnchor: pinsApi.setDraftAnchor,
    setFilter: pinsApi.setFilter,
    setFocusBlockId: docsApi.setFocusBlockId,
    setDocMode: docsApi.setDocMode,
    setOutputOpen: outputs.setOutputOpen,
    setPublishOpen: outputs.setPublishOpen,
    setGateError: notices.setGateError,
    setNotice: notices.setNotice,
  });

  pinsApi.fileHandler.current = (file: File) => {
    void flow.attachFromFile(file);
  };

  const { project, daemonStatus, daemonProjectId, sqliteMode, busy, publishes, revertable } = session;
  const { notice, gateError } = notices;
  const { doc, docs, specDoc, proposal, docMode, focusBlockId, ungroundedReqs, reqOptions } =
    docsApi;
  const { selectedPinId, filter, draftAnchor, dragging } = pinsApi;
  const { view, selectedGraphId } = graph;
  const {
    aiOpen,
    aiStatus,
    aiBusy,
    aiResult,
    aiSource,
    aiCardSource,
    aiSettings,
  } = ai;
  const { outputOpen, publishOpen, importInput } = outputs;

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

  return (
    <div className="app">
      <TopBar
        screen={screen}
        daemonStatus={daemonStatus}
        view={view}
        maturity={maturity}
        onView={graph.setView}
        onExport={() => void outputs.exportProject()}
        onImport={() => importInput.current?.click()}
        onBackup={() => void outputs.backupProject()}
        onReset={() => void flow.reset()}
        onOpenOutputs={() => outputs.setOutputOpen(true)}
        onOpenPublish={() => outputs.setPublishOpen(true)}
        onOpenAi={ai.openAiPanel}
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
          onChange={ai.updateAiSettings}
          onTest={() => void ai.runAiTest()}
          onEraseKeychain={() => void ai.runKeychainErase()}
          onPropose={(mode) => void ai.runAiProposal(mode)}
          onClose={() => {
            ai.setAiOpen(false);
            // QA R4: the badge must not freeze on the state the modal opened
            // with — a key that landed meanwhile shows on the way out.
            ai.refreshAiStatus();
          }}
        />
      )}

      <input
        ref={importInput}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) void outputs.importProject(file);
          event.target.value = '';
        }}
      />

      {daemonStatus === 'checking' ? (
        <div className="boot-screen" data-testid="boot" {...surfaceProps('bootScreen')}>
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
            // "채택 되돌리기" is only honest when the ledger's next undo is a
            // graph adoption — every command refreshes this state now (F-2).
            revertable === null || revertable.op !== 'graph.proposal.adopt'
              ? null
              : { seq: revertable.seq, summary: revertable.summary, nodes: revertable.nodes }
          }
          onSelect={graph.setSelectedGraphId}
          onCreateNode={graph.createGraphNode}
          onUpdateNode={graph.updateGraphNode}
          onDeleteNode={graph.deleteGraphNode}
          onCreateLink={graph.createGraphLink}
          onDeleteLink={graph.deleteGraphLink}
          onAckLink={graph.ackGraphLink}
          onProposal={graph.createGraphProposal}
          onAdopt={graph.adoptGraphProposal}
          onReject={graph.rejectGraphProposal}
          onRevert={() => void docsApi.revertAdopted()}
        />
      ) : screen !== null && project !== null ? (
        <main
          className={`studio${doc !== null && doc.kind === 'research' ? ' studio--research' : ''}`}
        >
          <section className="canvas-column" {...surfaceProps('canvas')}>
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
                  pinsApi.setDraftAnchor({ x: 0.5, y: 0.5 });
                  pinsApi.setSelectedPinId(null);
                }}
              >
                핀 추가
              </button>
              <span className="tool-hint">이미지 클릭 → 번호 핀</span>
            </div>

            <FigmaBar screen={screen} onSave={pinsApi.saveFigmaUrl} />

            <CanvasStage
              screen={screen}
              pins={pins}
              selectedPinId={selectedPinId}
              draft={draftAnchor}
              nextNumber={nextNumber}
              onCanvasClick={(anchor) => {
                pinsApi.setDraftAnchor(anchor);
                pinsApi.setSelectedPinId(null);
              }}
              onSelectPin={pinsApi.setSelectedPinId}
              onMovePin={pinsApi.movePin}
              onSavePin={(input) => void pinsApi.savePin(input)}
              onCancelDraft={() => pinsApi.setDraftAnchor(null)}
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
            onMode={docsApi.setDocMode}
            onSwitchDoc={docsApi.setActiveDocId}
            onCreateDoc={docsApi.createDoc}
            onDeleteDoc={docsApi.deleteDoc}
            onRenameDoc={docsApi.renameDoc}
            onAddBlock={docsApi.addBlock}
            onUpdateText={docsApi.updateBlockText}
            onChangeType={docsApi.changeBlockType}
            onDeleteBlock={docsApi.deleteBlock}
            onMoveBlock={docsApi.moveBlock}
            onLinkPin={docsApi.linkBlockPin}
            onUnlinkPin={docsApi.unlinkBlockPin}
            onClearStale={docsApi.clearStale}
            onSelectPin={pinsApi.setSelectedPinId}
            onCreateProposal={docsApi.createProposal}
            onAdopt={() => docsApi.decideProposal('adopt')}
            onReject={() => docsApi.decideProposal('reject')}
            onRevert={() => void docsApi.revertAdopted()}
            onFocusHandled={() => docsApi.setFocusBlockId(null)}
          />

          {doc !== null && doc.kind === 'research' && (
            <EvidencePanel
              evidence={project.evidence}
              requirements={reqOptions}
              busy={busy}
              onCapture={inbox.captureEvidence}
              onDismiss={inbox.dismissEvidence}
              onLink={inbox.linkEvidence}
            />
          )}

          <div className="side-rail">
            <PinPanel
              doc={doc}
              onFocusBlock={docsApi.setFocusBlockId}
              pins={pins}
              filter={filter}
              screenCode={screen.code}
              nextNumber={nextNumber}
              pinSeq={project.pinSeq}
              selectedPinId={selectedPinId}
              onFilter={pinsApi.setFilter}
              onSelect={pinsApi.setSelectedPinId}
              onDelete={(pin) => void pinsApi.deletePin(pin)}
              onUpdate={pinsApi.updatePin}
              onCloseEditor={() => pinsApi.setSelectedPinId(null)}
            />

            <IdeaInboxPanel
              ideas={project.ideas}
              evidence={project.evidence}
              busy={busy}
              briefBusy={aiBusy}
              sqliteMode={sqliteMode}
              captureOpen={inbox.inboxCaptureOpen}
              onOpenCapture={() => inbox.setInboxCaptureOpen(true)}
              onCloseCapture={() => inbox.setInboxCaptureOpen(false)}
              onCapture={inbox.captureIdea}
              onArchive={inbox.archiveIdea}
              onPromote={(idea) => void inbox.promoteIdea(idea)}
              onRunBrief={(ideaId, evidenceIds) => void ai.runBrief(ideaId, evidenceIds)}
              onRunAgent={(ideaId) => void runsApi.startAgentRun(ideaId)}
            />

            {sqliteMode && runsApi.runs.length > 0 && (
              <RunPanel
                runs={runsApi.runs}
                activeId={runsApi.activeRunId}
                log={runsApi.runLog}
                modelLabel={runsApi.runModelLabel}
                busy={busy}
                onSelect={runsApi.watchRun}
                onCancel={runsApi.cancelRun}
                onResume={runsApi.resumeRun}
                onAnswer={runsApi.answerRun}
              />
            )}
          </div>
        </main>
      ) : (
        <EntryGate
          error={gateError}
          onSample={flow.openSample}
          onFile={(file) => {
            void flow.attachFromFile(file);
          }}
          onFigma={flow.openFigma}
        />
      )}

      {dragging && (
        <div className="drop-veil" {...surfaceProps('dropVeil')}>
          이미지를 놓으면 화면으로 등록됩니다
        </div>
      )}
      {outputOpen && screen !== null && project !== null && (
        <OutputModal
          screen={screen}
          pins={pins}
          pinSeq={project.pinSeq}
          doc={specDoc}
          project={project}
          onExportPackage={async (files) => {
            await session.applyCommand({ type: 'project.package.export', files });
          }}
          onClose={() => outputs.setOutputOpen(false)}
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
            daemon={session.client}
            records={publishes}
            onRecords={session.setPublishes}
            onClose={() => outputs.setPublishOpen(false)}
          />
        )}
      {notice !== null && (
        <div
          className={`toast${notice.tone === 'error' ? ' toast--error' : ''}`}
          role="status"
          {...surfaceProps('notice')}
        >
          {notice.text}
        </div>
      )}
    </div>
  );
}
