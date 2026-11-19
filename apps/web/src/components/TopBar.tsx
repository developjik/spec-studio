import type { Screen } from '@spec-studio/protocol';
import type { DaemonStatus } from '../model/daemon';

interface TopBarProps {
  screen: Screen | null;
  daemonStatus: DaemonStatus;
  onExport: () => void;
  onImport: () => void;
  onReset: () => void;
  onOpenOutputs: () => void;
  onOpenPublish: () => void;
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

export function TopBar({
  screen,
  daemonStatus,
  onExport,
  onImport,
  onReset,
  onOpenOutputs,
  onOpenPublish,
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">spec-studio</span>
        <span className="chip">W4</span>
      </div>

      <DaemonBadge status={daemonStatus} />

      {screen !== null && (
        <div className="screen-id">
          <span className="screen-title" title={screen.title}>
            {screen.title}
          </span>
          <span className="mono screen-code">{screen.code}</span>
          <span className="screen-source">{sourceLabel(screen)}</span>
        </div>
      )}

      <div className="topbar-actions">
        {screen === null ? (
          <span className="topbar-note">
            {daemonStatus === 'offline'
              ? '브라우저에서만 동작하는 프로토타입'
              : 'SQLite 데몬에 연결되어 있습니다'}
          </span>
        ) : (
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
            <span className="topbar-divider" aria-hidden="true" />
            <button type="button" className="btn" onClick={onExport}>
              JSON 내보내기
            </button>
            <button type="button" className="btn" onClick={onImport}>
              불러오기
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
