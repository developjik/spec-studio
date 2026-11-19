import type { MouseEvent } from 'react';
import { PIN_TYPE_LABEL, type Anchor, type Pin, type Screen } from '@spec-studio/protocol';
import { PinComposer, type PinDraftInput } from './PinComposer';

interface CanvasStageProps {
  screen: Screen;
  pins: Pin[];
  selectedPinId: string | null;
  draft: Anchor | null;
  nextNumber: number;
  onCanvasClick: (anchor: Anchor) => void;
  onSelectPin: (pinId: string) => void;
  onSavePin: (input: PinDraftInput) => void;
  onCancelDraft: () => void;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function CanvasStage({
  screen,
  pins,
  selectedPinId,
  draft,
  nextNumber,
  onCanvasClick,
  onSelectPin,
  onSavePin,
  onCancelDraft,
}: CanvasStageProps) {
  const width = screen.viewport?.width ?? 1440;
  const height = screen.viewport?.height ?? 900;
  const ratio = width / height;

  const handleStageClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-pin]') !== null || target.closest('[data-composer]') !== null) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    onCanvasClick({
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    });
  };

  return (
    <div className="stage-shell">
      <div
        className="stage"
        style={{
          aspectRatio: `${width} / ${height}`,
          maxWidth: `min(100%, calc((100vh - 190px) * ${ratio.toFixed(4)}), ${width}px)`,
        }}
        onClick={handleStageClick}
        data-testid="stage"
        aria-label={`${screen.title} 화면 — 클릭해 핀을 추가합니다`}
      >
        {screen.ref.kind === 'image' ? (
          <img className="stage-image" src={screen.ref.value} alt="" draggable={false} />
        ) : (
          <div className="stage-placeholder">
            <div className="placeholder-card">
              <span className="placeholder-eyebrow">Figma frame</span>
              <span className="placeholder-title">{screen.title}</span>
              <span className="placeholder-url">{screen.ref.value}</span>
              <p className="placeholder-note">
                임베드는 아직 불러오지 않습니다. 이 영역을 클릭해 핀을 찍으세요.
              </p>
            </div>
          </div>
        )}

        {pins.map((pin) => (
          <button
            key={pin.id}
            type="button"
            className={`pin pin--${pin.type}${pin.id === selectedPinId ? ' is-selected' : ''}`}
            style={{ left: `${pin.anchor.x * 100}%`, top: `${pin.anchor.y * 100}%` }}
            title={`${PIN_TYPE_LABEL[pin.type]} · ${pin.title}`}
            aria-label={`핀 ${pin.number} ${PIN_TYPE_LABEL[pin.type]} ${pin.title}`}
            onClick={(event) => {
              event.stopPropagation();
              onSelectPin(pin.id);
            }}
            data-pin
            data-testid={`pin-${pin.number}`}
          >
            {pin.number}
          </button>
        ))}

        {draft !== null && (
          <PinComposer
            anchor={draft}
            number={nextNumber}
            onSave={onSavePin}
            onCancel={onCancelDraft}
          />
        )}

        {pins.length === 0 && draft === null && (
          <div className="stage-hint">
            이미지 위를 클릭해 첫 핀을 찍으세요
            <span>⌘/Ctrl + V 로 스크린샷 교체</span>
          </div>
        )}
      </div>
    </div>
  );
}
