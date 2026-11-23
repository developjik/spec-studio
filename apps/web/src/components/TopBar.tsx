import { useEffect, useState } from 'react';
import type { Screen } from '@spec-studio/protocol';
import type { Maturity } from '@spec-studio/core';
import type { DaemonProjectSummary, DaemonStatus } from '../model/daemon';
import { switcherLabel } from '../model/projects';

export type SwitcherProject = Pick<DaemonProjectSummary, 'id' | 'name' | 'screenTitle'>;

export type StudioView = 'studio' | 'graph';

interface TopBarProps {
  screen: Screen | null;
  daemonStatus: DaemonStatus;
  /** Daemon mode only; browser mode passes none and the switcher stays hidden. */
  projects: SwitcherProject[];
  currentProjectId: string | null;
  projectSwitchDisabled: boolean;
  onSwitchProject: (projectId: string) => void;
  onRefreshProjects: () => void;
  view: StudioView;
  maturity: Maturity;
  onView: (view: StudioView) => void;
  onExport: () => void;
  onImport: () => void;
  onBackup: () => void;
  onReset: () => void;
  onOpenOutputs: () => void;
  onOpenPublish: () => void;
  onOpenAi: () => void;
  /** The last card's origin, shown as a dot: the header has no room for words. */
  aiSource: 'llm' | 'rule' | null;
}

function sourceLabel(screen: Screen): string {
  switch (screen.ref.kind) {
    case 'image':
      return screen.ref.label ?? '이미지';
    case 'figma_frame':
      return 'Figma 프레임';
    case 'route':
      return '라우트';
  }
}

const DAEMON_LABEL: Record<DaemonStatus, string> = {
  checking: '데몬 확인 중…',
  connected: 'SQLite 데몬 연결됨',
  offline: '브라우저 임시 모드',
};

const LEVEL_LABEL: Record<Maturity['level'], string> = {
  L0: '초안',
  L1: '구조화',
  L2: '발행 준비',
};

function DaemonBadge({ status }: { status: DaemonStatus }) {
  return (
    <span
      className={`daemon-badge daemon-badge--${status}`}
      data-testid="daemon-status"
      data-status={status}
      title={
        status === 'connected'
          ? '프로젝트는 로컬 SQLite 파일에 저장됩니다'
          : status === 'offline'
            ? '데몬이 없어 이 브라우저(localStorage)에만 저장됩니다'
            : '127.0.0.1의 로컬 데몬을 찾는 중입니다'
      }
    >
      <span className="daemon-dot" aria-hidden="true" />
      {DAEMON_LABEL[status]}
    </span>
  );
}

/** One DB, many projects: the daemon's list, opened in place. */
function ProjectSwitcher({
  projects,
  currentProjectId,
  disabled,
  onSwitch,
  onRefresh,
}: {
  projects: SwitcherProject[];
  currentProjectId: string | null;
  disabled: boolean;
  onSwitch: (projectId: string) => void;
  onRefresh: () => void;
}) {
  const current = projects.find((project) => project.id === currentProjectId);
  return (
    <label className="project-switch" title="같은 SQLite DB의 다른 프로젝트를 엽니다">
      <span className="project-switch-label">프로젝트</span>
      <select
        className="project-switch-select"
        value={current?.id ?? ''}
        disabled={disabled}
        onFocus={onRefresh}
        onChange={(event) => {
          if (event.target.value !== '') onSwitch(event.target.value);
        }}
        aria-label="프로젝트 전환"
        data-testid="project-switcher"
        data-project-id={current?.id ?? ''}
      >
        {current === undefined && (
          <option value="" disabled>
            프로젝트 선택…
          </option>
        )}
        {projects.map((project) => (
          <option key={project.id} value={project.id} data-testid={`project-option-${project.id}`}>
            {switcherLabel(project)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The maturity badge shows the rung the screen stands on and, on hover, every
 * check that rung rests on — a badge nobody can interrogate is a decoration.
 */
function MaturityBadge({ maturity }: { maturity: Maturity }) {
  const [open, setOpen] = useState(false);

  // A popover, not <details>: the native element crashed Chromium's renderer
  // on reload inside this header, and a button is the same affordance without
  // the browser bug.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  return (
    <div
      className="maturity"
      data-testid="maturity-badge"
      data-level={maturity.level}
      data-todo={maturity.todo.map((check) => check.id).join(',')}
    >
      <button
        type="button"
        className="maturity-summary"
        aria-expanded={open}
        title={maturity.todo.map((check) => check.label).join(' · ')}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        data-testid="maturity-toggle"
      >
        <span className="maturity-level">{maturity.level}</span>
        <span className="maturity-name">{LEVEL_LABEL[maturity.level]}</span>
        {maturity.next !== null && maturity.todo.length > 0 && (
          <span className="maturity-todo-count">
            {LEVEL_LABEL[maturity.next.level]}까지 {maturity.todo.length}
          </span>
        )}
        {maturity.level === 'L2' && <span className="maturity-todo-count">검증 준비 완료</span>}
      </button>
      {open && (
        <div className="maturity-pop" data-testid="maturity-checklist" onClick={(event) => event.stopPropagation()}>
          {maturity.levels.map((level) => (
            <div key={level.level} className="maturity-row">
              <span
                className={`maturity-chip${level.level === maturity.level ? ' is-current' : ''}${level.checks.every((check) => check.done) ? ' is-done' : ''}`}
              >
                {level.level}
              </span>
              <ul>
                {level.checks.map((check) => (
                  <li
                    key={check.id}
                    className={check.done ? 'is-done' : ''}
                    data-testid={`check-${level.level}-${check.id}`}
                  >
                    <span className="check-mark" aria-hidden="true">
                      {check.done ? '✓' : '·'}
                    </span>
                    {check.label}
                    {!check.done && <span className="check-hint">{check.hint}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TopBar({
  screen,
  daemonStatus,
  projects,
  currentProjectId,
  projectSwitchDisabled,
  onSwitchProject,
  onRefreshProjects,
  view,
  maturity,
  onView,
  onExport,
  onImport,
  onBackup,
  onReset,
  onOpenOutputs,
  onOpenPublish,
  onOpenAi,
  aiSource,
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">spec-studio</span>
        <span className="chip">v1</span>
      </div>

      <DaemonBadge status={daemonStatus} />

      {daemonStatus === 'connected' && projects.length > 0 && (
        <ProjectSwitcher
          projects={projects}
          currentProjectId={currentProjectId}
          disabled={projectSwitchDisabled}
          onSwitch={onSwitchProject}
          onRefresh={onRefreshProjects}
        />
      )}

      {screen !== null && (
        <>
          <div className="view-tabs" role="tablist" aria-label="표면">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'studio'}
              className={`view-tab${view === 'studio' ? ' is-active' : ''}`}
              onClick={() => onView('studio')}
              data-testid="view-studio"
            >
              작업실
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'graph'}
              className={`view-tab${view === 'graph' ? ' is-active' : ''}`}
              onClick={() => onView('graph')}
              data-testid="view-graph"
            >
              그래프 · RTM
            </button>
          </div>

          <div className="screen-id">
            <span className="screen-title" title={screen.title}>
              {screen.title}
            </span>
            <span className="mono screen-code">{screen.code}</span>
            <span className="screen-source">{sourceLabel(screen)}</span>
          </div>

          <MaturityBadge maturity={maturity} />
        </>
      )}

      <div className="topbar-actions">
        <button
          type="button"
          className="btn btn--ai"
          onClick={onOpenAi}
          data-testid="ai-settings-open"
          data-ai-source={aiSource ?? 'none'}
          title={
            aiSource === 'llm'
              ? '마지막 제안은 LLM이 만들었습니다. 프로바이더 · 모델 · 키는 이 창의 메모리에만 있습니다.'
              : aiSource === 'rule'
                ? '마지막 제안은 로컬 규칙이 만들었습니다. 키를 넣으면 LLM 제안을 씁니다.'
                : 'LLM 프로바이더 · 모델 · 키를 이 창에만 두고 제안을 추출합니다'
          }
        >
          <span className="ai-spark" aria-hidden="true">
            ✦
          </span>
          AI 설정
          {aiSource !== null && (
            <span
              className={`ai-origin-dot${aiSource === 'llm' ? ' ai-origin-dot--llm' : ''}`}
              aria-hidden="true"
            />
          )}
        </button>
        {screen === null ? (
          <span className="topbar-note">
            {daemonStatus === 'offline'
              ? '브라우저에서만 동작하는 프로토타입'
              : 'SQLite 데몬에 연결되어 있습니다'}
          </span>
        ) : (
          <>
            {view === 'studio' ? (
              <>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={onOpenOutputs}
                  data-testid="open-outputs"
                  title="오버레이 PNG · 정적 HTML · QA CSV"
                >
                  출력 3종
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={onOpenPublish}
                  data-testid="open-publish"
                  disabled={daemonStatus !== 'connected'}
                  title={
                    daemonStatus === 'connected'
                      ? 'Confluence로 단방향 발행'
                      : '발행하려면 SQLite 데몬 연결이 필요합니다'
                  }
                >
                  Confluence 발행
                </button>
              </>
            ) : null}
            <span className="topbar-divider" aria-hidden="true" />
            <button type="button" className="btn" onClick={onExport} data-testid="export-project">
              JSON 내보내기
            </button>
            <button type="button" className="btn" onClick={onImport} data-testid="import-project">
              불러오기
            </button>
            <button
              type="button"
              className="btn"
              onClick={onBackup}
              disabled={daemonStatus !== 'connected'}
              title="SQLite 파일을 그대로 복제합니다"
              data-testid="backup-project"
            >
              SQLite 백업
            </button>
            <button type="button" className="btn" onClick={onReset}>
              새 화면
            </button>
          </>
        )}
      </div>
    </header>
  );
}
