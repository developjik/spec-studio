import { useCallback, useEffect, useRef, useState } from 'react';
import type { Pin, Screen } from '@spec-studio/protocol';
import { renderOverlayPng } from '../model/overlay';
import {
  blobToBase64,
  DaemonError,
  type ConfluenceTargetView,
  type DaemonClient,
  type PublishModeView,
  type PublishOutcomeView,
  type PublishPreviewView,
  type PublishRecordView,
} from '../model/daemon';

interface PublishModalProps {
  projectId: string;
  screen: Screen;
  screens?: readonly Screen[];
  pins: readonly Pin[];
  daemon: DaemonClient;
  records: readonly PublishRecordView[];
  onRecords: (records: PublishRecordView[]) => void;
  onClose: () => void;
}

const SETTINGS_KEY = 'spec-studio.confluence.v1';

interface RememberedSettings {
  baseUrl: string;
  space: string;
  email: string;
}

function loadSettings(): RememberedSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw === null) return { baseUrl: '', space: '', email: '' };
    const parsed = JSON.parse(raw) as Partial<RememberedSettings>;
    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
      space: typeof parsed.space === 'string' ? parsed.space : '',
      email: typeof parsed.email === 'string' ? parsed.email : '',
    };
  } catch {
    return { baseUrl: '', space: '', email: '' };
  }
}

/** Address, space and email are remembered. The API token never is. */
function rememberSettings(settings: RememberedSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // A full quota must not stop a publish.
  }
}

const PLAN_LABEL: Record<PublishPreviewView['plan'], string> = {
  create: '새 페이지 생성',
  update: '기존 페이지 갱신',
  skip: '이미 발행됨 · 건너뜀',
};

function stamp(value: string | null): string {
  if (value === null) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function PublishModal({
  projectId,
  screen,
  screens = [screen],
  pins,
  daemon,
  records,
  onRecords,
  onClose,
}: PublishModalProps) {
  const remembered = loadSettings();
  const [baseUrl, setBaseUrl] = useState(remembered.baseUrl);
  const [space, setSpace] = useState(remembered.space);
  const [email, setEmail] = useState(remembered.email);
  const [apiToken, setApiToken] = useState('');
  const [scope, setScope] = useState<string>(screen.id);
  const [mode, setMode] = useState<PublishModeView>('auto');
  const [tab, setTab] = useState<'preview' | 'history'>('preview');
  const [preview, setPreview] = useState<PublishPreviewView | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [outcome, setOutcome] = useState<PublishOutcomeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const refreshPreview = useCallback(async () => {
    if (space.trim() === '') {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    setPreviewLoading(true);
    try {
      const next = await daemon.preview(projectId, {
        space,
        mode,
        screenId: scope === 'all' ? (screens[0]?.id ?? screen.id) : scope,
      });
      if (!alive.current) return;
      setPreview(next);
      setPreviewError(null);
    } catch (reason) {
      if (!alive.current) return;
      setPreview(null);
      setPreviewError(
        reason instanceof DaemonError ? reason.message : '미리보기를 만들지 못했습니다.',
      );
    } finally {
      if (alive.current) setPreviewLoading(false);
    }
  }, [daemon, mode, projectId, space, scope, screens, screen.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshPreview();
    }, 350);
    return () => window.clearTimeout(timer);
  }, [refreshPreview]);

  const publish = async () => {
    setError(null);
    setOutcome(null);
    if (baseUrl.trim() === '' || space.trim() === '' || email.trim() === '') {
      setError('Base URL, Space, 이메일을 모두 입력해 주세요.');
      return;
    }
    if (apiToken.trim() === '') {
      setError('Confluence API 토큰을 입력해 주세요. (프로필 → 보안 → API 토큰)');
      return;
    }
    setPublishing(true);
    try {
      const target: ConfluenceTargetView = { baseUrl, space, email, apiToken };
      const selected = selectedScreens;
      if(!hasImage) throw new Error('선택한 화면에 이미지를 먼저 등록해 주세요.');
      if (selected.length === 0) throw new Error('발행할 화면을 선택해 주세요.');
      let result: PublishOutcomeView | null = null;
      for (const selectedScreen of selected) {
        const overlay = await renderOverlayPng(
          selectedScreen,
          pins.filter((p) => p.screenId === selectedScreen.id),
        );
        result = await daemon.publish(projectId, {
          target,
          mode,
          screenId: selectedScreen.id,
          overlayPng: await blobToBase64(overlay.blob),
        });
        // Keep successful records visible even when a later screen fails.
        const refreshed = await daemon.publishes(projectId);
        if (alive.current) onRecords(refreshed);
      }
      if (result === null) return;
      if (!alive.current) return;
      rememberSettings({ baseUrl, space, email });
      setOutcome(result);
      const refreshed = await daemon.publishes(projectId);
      if (alive.current) onRecords(refreshed);
      await refreshPreview();
      if (result.status !== 'skipped') setTab('history');
    } catch (reason) {
      if (!alive.current) return;
      setError(
        reason instanceof DaemonError
          ? reason.message
          : reason instanceof Error
            ? reason.message
            : '발행하지 못했습니다.',
      );
    } finally {
      if (alive.current) setPublishing(false);
    }
  };

  const figmaUrl = screen.figmaUrl ?? (screen.ref.kind === 'figma_frame' ? screen.ref.value : null);
  const selectedScreens=screens.filter(s=>scope==='all'||s.id===scope);
  const noImage=selectedScreens.filter(s=>s.ref.kind!=='image');
  const hasImage=selectedScreens.length>0&&noImage.length===0;

  return (
    <div className="modal-veil" role="presentation" onClick={onClose}>
      <section
        className="modal publish-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Confluence 발행"
        onClick={(event) => event.stopPropagation()}
        data-testid="publish-modal"
      >
        <header className="modal-head">
          <div className="modal-title">
            <h2>Confluence 발행</h2>
            <p>
              {screen.title} · <span className="mono">{screen.code}</span> · 핀{' '}
              {pins.filter((p) => p.screenId === screen.id).length}개 · 로컬 정본에서 단방향 복사
            </p>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="닫기"
            onClick={onClose}
            data-testid="publish-close"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M3 3l8 8M11 3l-8 8"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <div className="publish-body">
          <div className="publish-form">
            <h3>대상</h3>
            <label className="field">
              <span>발행 화면</span>
              <select
                className="input"
                aria-label="발행 화면"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                disabled={publishing}
              >
                <option value="all">전체 화면 ({screens.length}개)</option>
                {screens.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.code} · {s.title}
                  </option>
                ))}
              </select>
            </label>
            {scope === 'all' && (
              <p className="field-hint">
                전체 화면을 각 페이지로 차례로 발행합니다. 아래 미리보기는 첫 화면이며, 중간 실패 시
                이미 발행한 페이지는 기록에 남습니다.
              </p>
            )}
            <label className="field">
              <span>Base URL</span>
              <input
                className="input"
                value={baseUrl}
                placeholder="https://사이트.atlassian.net"
                onChange={(event) => setBaseUrl(event.target.value)}
                data-testid="publish-base-url"
              />
            </label>
            <label className="field">
              <span>Space ID 또는 Key</span>
              <input
                className="input"
                value={space}
                placeholder="SPEC 또는 12345"
                onChange={(event) => setSpace(event.target.value)}
                data-testid="publish-space"
              />
            </label>
            <label className="field">
              <span>이메일</span>
              <input
                className="input"
                value={email}
                placeholder="you@example.com"
                onChange={(event) => setEmail(event.target.value)}
                data-testid="publish-email"
              />
            </label>
            <label className="field">
              <span>API 토큰</span>
              <input
                className="input"
                type="password"
                value={apiToken}
                placeholder="Confluence 개인 API 토큰"
                autoComplete="off"
                onChange={(event) => setApiToken(event.target.value)}
                data-testid="publish-token"
              />
            </label>
            <p className="publish-hint">
              토큰은 이 창의 메모리에만 있고 SQLite·localStorage에 저장하지 않습니다. 창을 닫으면
              사라집니다. 주소·Space·이메일만 다음 발행을 위해 이 브라우저에 기억합니다.
            </p>

            <h3>발행 방식</h3>
            <div className="mode-group" role="radiogroup" aria-label="발행 방식">
              {(
                [
                  ['auto', '자동', '같은 스펙이면 건너뛰고, 바뀌었으면 기존 페이지를 갱신'],
                  ['create', '신규', '항상 새 페이지를 만듭니다'],
                  ['update', '갱신', '기존 페이지를 찾아 갱신합니다'],
                ] as const
              ).map(([value, label, hint]) => (
                <label key={value} className={`mode-option${mode === value ? ' is-active' : ''}`}>
                  <input
                    type="radio"
                    name="publish-mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                    data-testid={`publish-mode-${value}`}
                  />
                  <span className="mode-label">{label}</span>
                  <span className="mode-hint">{hint}</span>
                </label>
              ))}
            </div>

            {!hasImage && (
              <p className="publish-hint" data-testid="publish-no-image">
                선택한 화면에 이미지가 없어 발행할 수 없습니다: {noImage.map(s=>s.title).join(', ')}. 화면 이미지를 먼저 등록해 주세요.
              </p>
            )}

            <button
              type="button"
              className="btn btn--primary publish-run"
              onClick={() => void publish()}
              disabled={publishing || !hasImage}
              data-testid="publish-run"
            >
              {publishing ? '발행 중…' : 'Confluence로 발행'}
            </button>

            {error !== null && (
              <p className="publish-error" role="alert" data-testid="publish-error">
                {error}
              </p>
            )}

            {outcome !== null && (
              <div
                className={`publish-result publish-result--${outcome.status}`}
                data-testid="publish-result"
              >
                <strong data-testid="publish-result-status">
                  {outcome.status === 'created'
                    ? '새 페이지를 만들었습니다'
                    : outcome.status === 'updated'
                      ? '기존 페이지를 갱신했습니다'
                      : '중복 발행하지 않았습니다'}
                </strong>
                <p>{outcome.message}</p>
                {outcome.page !== null && outcome.page.url !== '' && (
                  <a
                    href={outcome.page.url}
                    target="_blank"
                    rel="noreferrer"
                    className="publish-link"
                    data-testid="publish-page-url"
                  >
                    {outcome.page.url}
                  </a>
                )}
                {outcome.attachments.length > 0 && (
                  <p className="publish-hint">
                    첨부:{' '}
                    {outcome.attachments
                      .map((item) => `${item.fileName} (${item.action})`)
                      .join(' · ')}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="publish-right">
            <div className="modal-tabs publish-tabs" role="tablist" aria-label="발행 정보">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'preview'}
                className={`modal-tab${tab === 'preview' ? ' is-active' : ''}`}
                onClick={() => setTab('preview')}
                data-testid="publish-tab-preview"
              >
                <span className="modal-tab-title">발행 미리보기</span>
                <span className="modal-tab-hint">본문 · 첨부 3종 · Figma 링크</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'history'}
                className={`modal-tab${tab === 'history' ? ' is-active' : ''}`}
                onClick={() => setTab('history')}
                data-testid="publish-tab-history"
              >
                <span className="modal-tab-title">발행 이력</span>
                <span className="modal-tab-hint">publish_record {records.length}건</span>
              </button>
            </div>

            <div className="publish-panel">
              {tab === 'preview' && (
                <>
                  {previewLoading && <p className="modal-loading">미리보기를 만드는 중…</p>}
                  {previewError !== null && <p className="modal-error">{previewError}</p>}
                  {preview !== null && (
                    <div data-testid="publish-preview">
                      <div className="publish-plan">
                        <span
                          className={`plan-badge plan-badge--${preview.plan}`}
                          data-testid="publish-preview-plan"
                          data-plan={preview.plan}
                        >
                          {PLAN_LABEL[preview.plan]}
                        </span>
                        <span className="mono publish-hash" title="스펙 해시">
                          {preview.specHash}
                        </span>
                      </div>
                      <p className="publish-title-line">
                        <span className="mono">{preview.title}</span>
                      </p>
                      {figmaUrl !== null && (
                        <p className="publish-title-line">
                          Figma 프레임{' '}
                          <a href={figmaUrl} target="_blank" rel="noreferrer">
                            {figmaUrl}
                          </a>
                        </p>
                      )}
                      <h4>첨부 3종</h4>
                      <ul className="publish-attachments" data-testid="publish-attachments">
                        {preview.attachments.map((attachment) => (
                          <li key={attachment.kind}>
                            <span className="mono">{attachment.fileName}</span>
                            <span className="publish-hint">{attachment.detail}</span>
                          </li>
                        ))}
                      </ul>
                      <h4>생성될 본문 (Storage Format)</h4>
                      <pre className="publish-body-preview" data-testid="publish-body">
                        {preview.body}
                      </pre>
                    </div>
                  )}
                  {preview === null && previewError === null && !previewLoading && (
                    <p className="modal-loading">
                      Space를 입력하면 발행 계획과 본문을 미리 보여줍니다.
                    </p>
                  )}
                </>
              )}

              {tab === 'history' && (
                <div data-testid="publish-history">
                  {records.length === 0 ? (
                    <p className="modal-loading">아직 발행 기록이 없습니다.</p>
                  ) : (
                    <table className="history-table">
                      <thead>
                        <tr>
                          <th>시각</th>
                          <th>결과</th>
                          <th>Space</th>
                          <th>페이지</th>
                          <th>스펙 해시</th>
                        </tr>
                      </thead>
                      <tbody>
                        {records.map((record) => (
                          <tr key={record.id} data-status={record.status}>
                            <td>{stamp(record.publishedAt ?? record.at)}</td>
                            <td>
                              <span className={`status-chip status-chip--${record.status}`}>
                                {record.status === 'ok'
                                  ? '발행됨'
                                  : record.status === 'failed'
                                    ? '실패'
                                    : record.status === 'intent'
                                      ? '진행 중'
                                      : '차단'}
                              </span>
                            </td>
                            <td className="mono">{record.spaceKey ?? '—'}</td>
                            <td>
                              {record.remoteUrl === null ? (
                                <span className="publish-hint">{record.pageId ?? '—'}</span>
                              ) : (
                                <a href={record.remoteUrl} target="_blank" rel="noreferrer">
                                  {record.pageId ?? '페이지'}
                                </a>
                              )}
                            </td>
                            <td className="mono publish-hash">
                              {record.specHash === null ? '—' : record.specHash.slice(0, 10)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
