import { useState } from 'react';
import type { Screen } from '@spec-studio/protocol';
import { surfaceProps } from '../model/surfaces';

interface FigmaBarProps {
  screen: Screen;
  onSave: (url: string | null) => void;
}

/**
 * The Figma frame is reference data attached to the screen: it is displayed,
 * linked and copied into the published body, never embedded or fetched.
 */
export function FigmaBar({ screen, onSave }: FigmaBarProps) {
  const current = screen.figmaUrl ?? (screen.ref.kind === 'figma_frame' ? screen.ref.value : null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(current ?? '');
  const [error, setError] = useState<string | null>(null);

  const commit = () => {
    const raw = draft.trim();
    if (raw === '') {
      setError('Figma 프레임 주소를 입력해 주세요.');
      return;
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      setError('https://www.figma.com/… 형식의 주소를 입력해 주세요.');
      return;
    }
    if (!/(^|\.)figma\.com$/.test(url.hostname)) {
      setError('Figma 주소(figma.com)만 등록할 수 있습니다.');
      return;
    }
    setError(null);
    onSave(url.toString());
    setEditing(false);
  };

  if (editing) {
    return (
      <div
        className="figma-bar figma-bar--edit"
        data-testid="figma-editor"
        {...surfaceProps('figmaBar')}
      >
        <span className="figma-label">Figma 프레임</span>
        <input
          className="input figma-input"
          value={draft}
          placeholder="https://www.figma.com/design/…?node-id=12-34"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
            if (event.key === 'Escape') {
              setEditing(false);
              setError(null);
            }
          }}
          data-testid="figma-url-input"
          autoFocus
        />
        <button type="button" className="btn btn--sm btn--primary" onClick={commit} data-testid="figma-save">
          저장
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
        >
          취소
        </button>
        {error !== null && <span className="figma-error">{error}</span>}
      </div>
    );
  }

  return (
    <div className="figma-bar" data-testid="figma-bar" {...surfaceProps('figmaBar')}>
      <span className="figma-label">Figma 프레임</span>
      {current === null ? (
        <>
          <span className="figma-empty">등록되지 않음 · 발행 본문에 링크가 들어가지 않습니다</span>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setDraft('');
              setEditing(true);
            }}
            data-testid="figma-register"
          >
            프레임 등록
          </button>
        </>
      ) : (
        <>
          <a
            className="figma-link"
            href={current}
            target="_blank"
            rel="noreferrer"
            data-testid="figma-link"
          >
            {current}
          </a>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setDraft(current);
              setEditing(true);
            }}
            data-testid="figma-edit"
          >
            수정
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => onSave(null)}
            data-testid="figma-clear"
          >
            해제
          </button>
        </>
      )}
    </div>
  );
}
