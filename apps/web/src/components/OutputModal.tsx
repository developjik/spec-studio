import { useEffect, useState } from 'react';
import { OUTPUT_SPECS, buildSpecOverview, type OutputKind } from '@spec-studio/core';
import type { Doc, Pin, Project, Screen } from '@spec-studio/protocol';
import { downloadBlob, downloadMany, formatBytes } from '../model/downloads';
import {
  buildOutputSet,
  buildPackageFiles,
  packageZipName,
  type BuiltOutput,
} from '../model/outputs';
import { buildZip } from '../model/zip';
import { surfaceProps } from '../model/surfaces';

interface OutputModalProps {
  screen: Screen;
  pins: readonly Pin[];
  pinSeq: number;
  doc?: Doc | null;
  /** The package's source of truth — summary, tasks and bundle all read it. */
  project: Project;
  /** F4: the export is a ledger entry; the app records it through the command path. */
  onExportPackage: (files: string[]) => void | Promise<void>;
  onClose: () => void;
}

const GENERATED_AT = () => localStamp();

/** Local time with its offset, so a handoff sheet says when it was made where it was made. */
function localStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

/**
 * Preview and download in one place: the three outputs come from one build,
 * so what the preview shows is byte-for-byte what the download writes.
 */
export function OutputModal({ screen, pins, pinSeq, doc, project, onExportPackage, onClose }: OutputModalProps) {
  const [files, setFiles] = useState<BuiltOutput[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<OutputKind>('overlay-png');
  const [packing, setPacking] = useState(false);
  const [exportedOnce, setExportedOnce] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // F4: one click → one zip of six files. A repeat asks first, because it
  // writes the same name again — the spec's 폴더 덮어쓰기 confirmation.
  const exportPackage = async () => {
    setPacking(true);
    setError(null);
    try {
      const entries = await buildPackageFiles({ project, screen, pins, pinSeq, doc: doc ?? null });
      downloadBlob(packageZipName(screen), new Blob([buildZip(entries).buffer as ArrayBuffer], { type: 'application/zip' }));
      await onExportPackage(entries.map((entry) => entry.name));
      setExportedOnce(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '패키지를 만들지 못했습니다.');
    } finally {
      setPacking(false);
      setConfirming(false);
    }
  };

  useEffect(() => {
    let alive = true;
    buildOutputSet({ screen, pins, pinSeq, doc: doc ?? null, generatedAt: GENERATED_AT() })
      .then((set) => {
        if (alive) setFiles(set.files);
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : '출력을 만들지 못했습니다.');
      });
    return () => {
      alive = false;
    };
  }, [screen, pins, pinSeq]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const overview = buildSpecOverview({ screen, pins, pinSeq });
  const active = files?.find((file) => file.kind === tab) ?? null;

  return (
    <div
      className="modal-veil"
      role="presentation"
      onClick={onClose}
      {...surfaceProps('outputModal')}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="출력 3종 미리보기"
        onClick={(event) => event.stopPropagation()}
        data-testid="output-modal"
      >
        <header className="modal-head">
          <div className="modal-title">
            <h2>출력 3종</h2>
            <p>
              {screen.title} · <span className="mono">{screen.code}</span> · 핀 {overview.total}개
              {overview.gaps.length > 0 ? ` · 결번 ${overview.gaps.map((n) => `#${n}`).join(', ')}` : ''}
            </p>
          </div>
          <button type="button" className="icon-btn" aria-label="닫기" onClick={onClose} data-testid="output-close">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="modal-tabs" role="tablist" aria-label="출력 종류">
          {OUTPUT_SPECS.map((spec) => (
            <button
              key={spec.kind}
              type="button"
              role="tab"
              aria-selected={tab === spec.kind}
              className={`modal-tab${tab === spec.kind ? ' is-active' : ''}`}
              onClick={() => setTab(spec.kind)}
              data-testid={`output-tab-${spec.kind}`}
            >
              <span className="modal-tab-title">{spec.title}</span>
              <span className="modal-tab-hint">{spec.hint}</span>
            </button>
          ))}
        </div>

        <div className="modal-preview" data-testid={`output-preview-${tab}`}>
          {error !== null && <p className="modal-error">{error}</p>}
          {error === null && files === null && <p className="modal-loading">생성 중…</p>}
          {active !== null && tab === 'overlay-png' && active.dataUrl !== null && (
            <figure className="preview-figure">
              <img src={active.dataUrl} alt="번호 핀이 합성된 오버레이 미리보기" data-testid="output-overlay-preview" />
              <figcaption>{active.detail}</figcaption>
            </figure>
          )}
          {active !== null && tab === 'spec-html' && active.text !== null && (
            <iframe
              className="preview-frame"
              title="정적 HTML 미리보기"
              srcDoc={active.text}
              data-testid="output-html-preview"
            />
          )}
          {active !== null && tab === 'qa-csv' && active.text !== null && (
            <pre className="preview-code" data-testid="output-csv-preview">
              {active.text.replace(/^\uFEFF/, '')}
            </pre>
          )}
        </div>

        <footer className="modal-foot">
          <div className="modal-file">
            {active !== null ? (
              <>
                <span className="mono">{active.fileName}</span>
                <span className="modal-size">{formatBytes(active.bytes)}</span>
                <span className="modal-detail">{active.detail}</span>
              </>
            ) : (
              <span className="modal-detail">파일을 만드는 중입니다.</span>
            )}
          </div>
          <div className="modal-actions">
            <button
              type="button"
              className="btn btn--sm"
              disabled={active === null}
              onClick={() => {
                if (active !== null) downloadBlob(active.fileName, active.blob);
              }}
              data-testid="output-download-active"
            >
              이 파일 내려받기
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={files === null}
              onClick={() => {
                if (files !== null) {
                  void downloadMany(files.map((file) => ({ fileName: file.fileName, blob: file.blob })));
                }
              }}
              data-testid="output-download-all"
            >
              3종 한 번에
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={packing}
              onClick={() => {
                if (exportedOnce) setConfirming(true);
                else void exportPackage();
              }}
              data-testid="package-export"
            >
              {packing ? '패키지 만드는 중…' : '전달 패키지 (6종)'}
            </button>
          </div>
          {confirming && (
            <div className="modal-confirm" data-testid="package-confirm">
              <span>같은 이름으로 다시 내보냅니다. 이전 패키지를 덮어씁니다.</span>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => void exportPackage()}
                data-testid="package-confirm-submit"
              >
                덮어쓰기
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setConfirming(false)}
                data-testid="package-confirm-cancel"
              >
                취소
              </button>
            </div>
          )}
        </footer>
      </section>
    </div>
  );
}
