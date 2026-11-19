import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  PIN_TYPE_LABEL,
  V1_PIN_TYPES,
  type Anchor,
  type PinType,
} from '@spec-studio/protocol';

export interface PinDraftInput {
  pinType: PinType;
  title: string;
  body: string;
}

interface PinComposerProps {
  anchor: Anchor;
  number: number;
  onSave: (input: PinDraftInput) => void;
  onCancel: () => void;
}

export function PinComposer({ anchor, number, onSave, onCancel }: PinComposerProps) {
  const [pinType, setPinType] = useState<PinType>('function');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const submit = () => {
    const trimmed = title.trim();
    if (trimmed === '') return;
    onSave({ pinType, title: trimmed, body: body.trim() });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCancel();
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      className="composer"
      data-composer
      style={{ left: `${anchor.x * 100}%`, top: `${anchor.y * 100}%` }}
      data-side={anchor.x > 0.62 ? 'left' : 'right'}
      data-flip={anchor.y > 0.56 ? 'up' : 'down'}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      aria-label="새 핀 작성"
    >
      <div className="composer-head">
        <span className="composer-label">새 핀</span>
        <span className="composer-number">#{number}</span>
      </div>

      <div className="segmented" role="group" aria-label="핀 타입">
        {V1_PIN_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            aria-pressed={pinType === type}
            onClick={() => setPinType(type)}
            data-testid={`type-${type}`}
          >
            {PIN_TYPE_LABEL[type]}
          </button>
        ))}
      </div>

      <input
        ref={titleRef}
        className="input"
        placeholder="한 줄 제목 — 예: 배송 전에만 취소 가능"
        maxLength={120}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        data-testid="pin-title"
      />

      <textarea
        className="textarea"
        placeholder="설명 · 조건 · 재현 방법"
        maxLength={4000}
        rows={3}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        data-testid="pin-body"
      />

      <div className="composer-foot">
        <span className="composer-hint">⌘/Ctrl + Enter 저장</span>
        <span className="composer-buttons">
          <button type="button" className="btn btn--sm" onClick={onCancel}>
            취소
          </button>
          <button
            type="submit"
            className="btn btn--primary btn--sm"
            disabled={title.trim() === ''}
            data-testid="pin-save"
          >
            핀 찍기
          </button>
        </span>
      </div>
    </form>
  );
}
