import { useState, type FormEvent } from 'react';
import { PIN_TYPE_LABEL, V1_PIN_TYPES, type Pin, type PinType } from '@spec-studio/protocol';
import { pinLabel } from '@spec-studio/core';

export interface PinEditInput {
  pinType: PinType;
  title: string;
  body: string;
}

interface PinEditorProps {
  pin: Pin;
  screenCode: string;
  onSave: (input: PinEditInput) => void;
  onClose: () => void;
}

/**
 * Editing keeps the number: the form has no field for it, and the command it
 * sends has none either. Moving is done on the image, not here.
 */
export function PinEditor({ pin, screenCode, onSave, onClose }: PinEditorProps) {
  const [pinType, setPinType] = useState<PinType>(pin.type);
  const [title, setTitle] = useState(pin.title);
  const [body, setBody] = useState(pin.body);

  const dirty =
    pinType !== pin.type || title.trim() !== pin.title || body.trim() !== pin.body;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (title.trim() === '') return;
    onSave({ pinType, title: title.trim(), body: body.trim() });
  };

  return (
    <form className="editor" onSubmit={submit} aria-label={`핀 ${pin.number} 편집`} data-testid="pin-editor">
      <div className="editor-head">
        <span className="editor-label">
          <span className={`num num--${pin.type}`}>{pin.number}</span>
          {pinLabel(screenCode, pin.number)} 편집
        </span>
        <button type="button" className="icon-btn" aria-label="편집 닫기" onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="segmented" role="group" aria-label="핀 타입 변경">
        {V1_PIN_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            aria-pressed={pinType === type}
            onClick={() => setPinType(type)}
            data-testid={`edit-type-${type}`}
          >
            {PIN_TYPE_LABEL[type]}
          </button>
        ))}
      </div>

      <input
        className="input"
        value={title}
        maxLength={120}
        aria-label="핀 제목"
        onChange={(event) => setTitle(event.target.value)}
        data-testid="edit-title"
      />

      <textarea
        className="textarea"
        value={body}
        maxLength={4000}
        rows={4}
        aria-label="핀 설명"
        placeholder="설명 · 조건 · 재현 방법"
        onChange={(event) => setBody(event.target.value)}
        data-testid="edit-body"
      />

      <p className="editor-hint">이미지 위에서 핀을 끌면 위치가 바뀝니다 (번호는 그대로).</p>

      <div className="editor-foot">
        <button type="submit" className="btn btn--primary btn--sm" disabled={!dirty || title.trim() === ''} data-testid="edit-save">
          저장
        </button>
        <button type="button" className="btn btn--sm" onClick={onClose}>
          닫기
        </button>
        <span className="editor-dirty">{dirty ? '저장하지 않은 변경' : '저장됨'}</span>
      </div>
    </form>
  );
}
