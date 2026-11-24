import { useState, type FormEvent } from 'react';
import { surfaceProps } from '../model/surfaces';

interface EntryGateProps {
  error: string | null;
  onSample: () => void;
  onFile: (file: File) => void;
  onFigma: (url: string) => void;
}

export function EntryGate({ error, onSample, onFile, onFigma }: EntryGateProps) {
  const [figmaUrl, setFigmaUrl] = useState('');

  const submitFigma = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submittedUrl = figmaUrl.trim();
    setFigmaUrl('');
    if (submittedUrl === '') return;
    onFigma(submittedUrl);
  };

  return (
    <main className="gate" {...surfaceProps('entryGate')}>
      <div className="gate-inner">
        <p className="eyebrow">첫 3분</p>
        <h1>
          화면 한 장이면
          <br />
          기획이 시작됩니다.
        </h1>
        <p className="lede">
          스크린샷을 붙여넣고, 이미지 위를 클릭해 번호 핀을 찍으세요. 핀 번호는 한 번 부여되면
          삭제해도 다시 쓰지 않습니다 — 발행된 <span className="mono">SCR-110-3</span>이 거짓이
          되지 않도록.
        </p>

        <div className="entries">
          <button
            type="button"
            className="entry entry--primary"
            onClick={onSample}
            data-testid="entry-sample"
          >
            <span className="entry-index">01</span>
            <span className="entry-body">
              <span className="entry-title">샘플 화면 열기</span>
              <span className="entry-desc">주문 상세 화면으로 바로 시작합니다</span>
            </span>
            <span className="entry-arrow" aria-hidden="true">
              →
            </span>
          </button>

          <div className="entry">
            <span className="entry-index">02</span>
            <span className="entry-body">
              <span className="entry-title">스크린샷</span>
              <span className="entry-desc">
                <span className="mono">Ctrl/Cmd + V</span> 붙여넣기, 또는 파일을 창에 끌어다
                놓으세요
              </span>
            </span>
            <label className="btn">
              파일 선택
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onFile(file);
                  event.target.value = '';
                }}
              />
            </label>
          </div>

          <form className="entry" onSubmit={submitFigma} noValidate>
            <span className="entry-index">03</span>
            <span className="entry-body">
              <span className="entry-title">Figma URL</span>
              <span className="entry-desc">프레임 주소를 먼저 등록해 두어도 됩니다</span>
            </span>
            <span className="figma-row">
              <input
                className="input"
                type="url"
                inputMode="url"
                placeholder="https://www.figma.com/file/…"
                aria-label="Figma 프레임 URL"
                value={figmaUrl}
                onChange={(event) => setFigmaUrl(event.target.value)}
                data-testid="figma-url"
              />
              <button type="submit" className="btn btn--sm">
                등록
              </button>
            </span>
          </form>
        </div>

        {error !== null && (
          <p className="gate-error" role="alert">
            {error}
          </p>
        )}
        <p className="gate-foot">
          모든 데이터는 이 브라우저에만 저장됩니다 · 서버 전송 없음 · 계정 불필요
        </p>
      </div>
    </main>
  );
}
