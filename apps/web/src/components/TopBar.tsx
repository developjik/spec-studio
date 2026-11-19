import type { Screen } from '@spec-studio/protocol';

interface TopBarProps {
  screen: Screen | null;
  onExport: () => void;
  onImport: () => void;
  onReset: () => void;
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

export function TopBar({ screen, onExport, onImport, onReset }: TopBarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">spec-studio</span>
        <span className="chip">W1</span>
      </div>

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
          <span className="topbar-note">브라우저에서만 동작하는 프로토타입</span>
        ) : (
          <>
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
