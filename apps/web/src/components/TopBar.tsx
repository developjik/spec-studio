import { useEffect, useState } from 'react';
import type { Screen } from '@spec-studio/protocol';
import type { Maturity } from '@spec-studio/core';
import type { DaemonStatus } from '../model/daemon';
import type { UiMode } from '../model/settings';
import { surfaceProps } from '../model/surfaces';

export type StudioView = 'studio' | 'graph';

interface TopBarProps {
  screen: Screen | null;
  daemonStatus: DaemonStatus;
  view: StudioView;
  maturity: Maturity;
  /** E4 F1: the easy/pro preference — gates pro-only controls in this bar. */
  uiMode: UiMode;
  onToggleMode: () => void;
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
  view,
  maturity,
  uiMode,
  onToggleMode,
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
    <header className="topbar" {...surfaceProps('topBar')}>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">spec-studio</span>
        <span className="chip">v1</span>
      </div>

      <DaemonBadge status={daemonStatus} />

      <button
        type="button"
        className="btn btn--sm mode-switch"
        onClick={onToggleMode}
        data-testid="mode-switch"
        data-mode={uiMode}
        title={
          uiMode === 'easy'
            ? '전문 모드로 전환 — 그래프·인박스·근거·에이전트·발행·백업을 엽니다'
            : '간편 모드로 전환 — 캔버스·문서·제안 카드·출력만 둡니다'
        }
      >
        {uiMode === 'easy' ? '전문 모드로 전환' : '간편 모드로 전환'}
      </button>

      {screen !== null && (
        <>
          {uiMode === 'pro' && (
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
          )}

          <div className="screen-id">
            <span className="screen-title" title={screen.title}>
              {screen.title}
            </span>
            <span className="mono screen-code">{screen.code}</span>
            <span className="screen-source">{sourceLabel(screen)}</span>
          </div>

          {/* DG-1: the raw L0→L2 checklist is pro's presentation — easy gets
              the "다음 할 일" card instead (F4), never the checklist itself. */}
          {uiMode === 'pro' && <MaturityBadge maturity={maturity} />}
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
                ? '마지막 제안은 AI 없이 규칙으로 만들었습니다. 키를 넣으면 LLM 제안을 씁니다.'
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
          {aiSource === 'rule' && uiMode === 'easy' && (
            <span className="ai-origin-tag" data-testid="ai-origin-tag">
              AI 없음·규칙 기반 제안
            </span>
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
            {(uiMode === 'easy' || view === 'studio') && (
              <button
                type="button"
                className="btn btn--primary"
                onClick={onOpenOutputs}
                data-testid="open-outputs"
                title="오버레이 PNG · 정적 HTML · QA CSV"
              >
                출력 3종
              </button>
            )}
            {uiMode === 'pro' && view === 'studio' && (
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
            )}
            <span className="topbar-divider" aria-hidden="true" />
            <button type="button" className="btn" onClick={onExport} data-testid="export-project">
              JSON 내보내기
            </button>
            {uiMode === 'pro' && (
              <button type="button" className="btn" onClick={onImport} data-testid="import-project">
                불러오기
              </button>
            )}
            {uiMode === 'pro' && (
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
            )}
            <button type="button" className="btn" onClick={onReset}>
              새 화면
            </button>
          </>
        )}
      </div>
    </header>
  );
}
