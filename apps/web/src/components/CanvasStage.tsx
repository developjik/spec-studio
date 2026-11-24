import { useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
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
  onMovePin: (pinId: string, anchor: Anchor) => void;
  onSavePin: (input: PinDraftInput) => void;
  onCancelDraft: () => void;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

interface DragState {
  id: string;
  anchor: Anchor;
  moved: boolean;
}

interface DragVisual {
  id: string;
  anchor: Anchor;
}

export function CanvasStage({
  screen,
  pins,
  selectedPinId,
  draft,
  nextNumber,
  onCanvasClick,
  onSelectPin,
  onMovePin,
  onSavePin,
  onCancelDraft,
}: CanvasStageProps) {
  const width = screen.viewport?.width ?? 1440;
  const height = screen.viewport?.height ?? 900;
  const ratio = width / height;

  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [dragVisual, setDragVisual] = useState<DragVisual | null>(null);

  const anchorAt = (clientX: number, clientY: number): Anchor | null => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0 || rect.height === 0) return null;
    return {
      x: clamp01((clientX - rect.left) / rect.width),
      y: clamp01((clientY - rect.top) / rect.height),
    };
  };

  const handleStageClick = (event: MouseEvent<HTMLDivElement>) => {
    if (dragRef.current !== null) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-pin]') !== null || target.closest('[data-composer]') !== null) return;
    const anchor = anchorAt(event.clientX, event.clientY);
    if (anchor !== null) onCanvasClick(anchor);
  };

  /**
   * A press that never leaves the 3px slop is a selection; a press that moves
   * is a reposition. Both are one gesture on the same marker, which is what
   * makes dragging feel like moving a sticker rather than opening a form.
   */
  const beginPinGesture = (event: ReactPointerEvent<HTMLButtonElement>, pin: Pin) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const start = { x: event.clientX, y: event.clientY };
    dragRef.current = { id: pin.id, anchor: pin.anchor, moved: false };
    setDragVisual(null);

    const onMove = (native: globalThis.PointerEvent) => {
      const state = dragRef.current;
      if (state === null || state.id !== pin.id) return;
      if (!state.moved && Math.hypot(native.clientX - start.x, native.clientY - start.y) < 3) return;
      const anchor = anchorAt(native.clientX, native.clientY);
      if (anchor === null) return;
      state.moved = true;
      state.anchor = anchor;
      setDragVisual({ id: pin.id, anchor });
    };

    const finish = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      const state = dragRef.current;
      dragRef.current = null;
      setDragVisual(null);
      if (state === null) return;
      if (state.moved) onMovePin(state.id, state.anchor);
      else onSelectPin(state.id);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  return (
    <div className="stage-shell">
      <div
        ref={stageRef}
        className={`stage${dragVisual !== null ? ' is-dragging' : ''}`}
        style={{
          aspectRatio: `${width} / ${height}`,
          maxWidth: `min(100%, calc((100vh - 190px) * ${ratio.toFixed(4)}), ${width}px)`,
        }}
        onClick={handleStageClick}
        data-testid="stage"
        aria-label={`${screen.title} 화면 — 클릭해 핀을 추가하고, 핀을 끌어 옮깁니다`}
      >
        {screen.ref.kind === 'image' ? (
          <img className="stage-image" src={screen.ref.value} alt="" draggable={false} />
        ) : (
          <div className="stage-placeholder">
            <div className="placeholder-card">
              <span className="placeholder-eyebrow">Figma frame</span>
              <span className="placeholder-title">{screen.title}</span>
              <span className="placeholder-url">{screen.figmaUrl ?? screen.ref.value}</span>
              <p className="placeholder-note">
                임베드는 아직 불러오지 않습니다. 이 영역을 클릭해 핀을 찍으세요.
              </p>
            </div>
          </div>
        )}

        {pins.map((pin) => {
          const anchor = dragVisual?.id === pin.id ? dragVisual.anchor : pin.anchor;
          const dragging = dragVisual?.id === pin.id;
          return (
            <button
              key={pin.id}
              type="button"
              className={`pin pin--${pin.type}${pin.id === selectedPinId ? ' is-selected' : ''}${
                dragging ? ' is-dragging' : ''
              }`}
              style={{ left: `${anchor.x * 100}%`, top: `${anchor.y * 100}%` }}
              title={`${PIN_TYPE_LABEL[pin.type]} · ${pin.title} — 끌어서 이동`}
              aria-label={`핀 ${pin.number} ${PIN_TYPE_LABEL[pin.type]} ${pin.title}`}
              onPointerDown={(event) => beginPinGesture(event, pin)}
              onClick={(event) => {
                event.stopPropagation();
                // Keyboard activation has no pointer gesture; mouse clicks were
                // already handled on pointerup.
                if (event.detail === 0) onSelectPin(pin.id);
              }}
              data-pin
              data-testid={`pin-${pin.number}`}
              data-anchor={`${anchor.x.toFixed(4)},${anchor.y.toFixed(4)}`}
            >
              {pin.number}
            </button>
          );
        })}

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
