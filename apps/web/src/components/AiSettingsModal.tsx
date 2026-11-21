import {
  AI_PRESETS,
  AI_PROVIDER_LABEL,
  findPreset,
  type AiProposalMode,
  type AiProvider,
} from '@spec-studio/protocol';
import type { AiStatusView } from '../model/daemon';

/**
 * AI 설정 — BYOK 탭.
 *
 * A preset, a model, an endpoint, a key. The key lives in this window's state
 * for as long as the tab does, is sent with one request and dropped by the
 * daemon — or, on the desktop app, moved into the OS keychain, which is
 * write-only: the app can use it and delete it but never show it again.
 *
 * The same panel proposes, because a person who has just typed an endpoint
 * wants to see what it drafts without hunting for another button.
 */

export interface AiSettingsValue {
  /** A preset id from AI_PRESETS, or 'local' for the rule extractor. */
  presetId: string;
  /** The wire protocol the preset speaks; 'local' when presetId is 'local'. */
  provider: AiProvider;
  model: string;
  endpoint: string;
  apiKey: string;
  /** Checked = "이 컴퓨터 키체인에 저장" — applied on a successful 연결 확인. */
  saveToKeychain: boolean;
}

export interface AiPanelResult {
  tone: 'info' | 'error';
  text: string;
}

interface AiSettingsModalProps {
  value: AiSettingsValue;
  status: AiStatusView | null;
  busy: boolean;
  result: AiPanelResult | null;
  hasDoc: boolean;
  sqliteMode: boolean;
  onChange: (patch: Partial<AiSettingsValue>) => void;
  onTest: () => void;
  onEraseKeychain: () => void;
  onPropose: (mode: AiProposalMode) => void;
  onClose: () => void;
}

export function AiSettingsModal(props: AiSettingsModalProps) {
  const { value, status, busy, result } = props;
  const local = value.presetId === 'local';
  const remote = !local;
  const preset = findPreset(value.presetId);
  const keyless = preset?.authMode === 'none';
  const providerStatus =
    status?.providers.find((entry) => entry.provider === value.provider) ?? null;
  const hasKeychainKey =
    status?.presets?.find((entry) => entry.id === value.presetId)?.hasKeychainKey === true;
  const keychainAvailable = status?.keychainAvailable === true;

  const changePreset = (presetId: string) => {
    if (presetId === 'local') {
      props.onChange({
        presetId: 'local',
        provider: 'local',
        model: '',
        endpoint: '',
        saveToKeychain: false,
      });
      return;
    }
    const next = findPreset(presetId);
    props.onChange({
      presetId,
      provider: next?.provider ?? 'openai',
      model: next?.defaultModel ?? '',
      endpoint: next?.baseUrl ?? '',
      apiKey: '',
      saveToKeychain: false,
    });
  };

  /** Which chain step would supply the key right now (request > keychain > env > rules). */
  const effectiveSource = keyless
    ? '키 없음 (로컬 서버)'
    : value.apiKey.trim() !== ''
      ? '지금 입력한 키'
      : hasKeychainKey
        ? '키체인'
        : providerStatus?.hasEnvKey === true
          ? '환경변수'
          : '로컬 규칙 폴백';

  return (
    <div className="modal-veil" data-testid="ai-modal" onClick={props.onClose}>
      <section
        className="modal ai-modal"
        role="dialog"
        aria-label="AI 설정"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div className="modal-title">
            <h2>제안 엔진</h2>
            <p>AI 설정 · 키는 이 창의 메모리나 OS 키체인에만 있습니다</p>
          </div>
          <button type="button" className="btn btn--sm" onClick={props.onClose} data-testid="ai-close">
            닫기
          </button>
        </header>

        <div className="modal-tabs modal-tabs--2" role="tablist">
          <button
            type="button"
            className="modal-tab is-active"
            role="tab"
            aria-selected="true"
            data-testid="ai-tab-byok"
          >
            <span className="modal-tab-title">BYOK 키</span>
            <span className="modal-tab-hint">직접 발급한 키 · 프리셋</span>
          </button>
          <button
            type="button"
            className="modal-tab"
            role="tab"
            aria-selected="false"
            disabled
            title="구독(관리형 AI)은 E2에서 제공 예정입니다"
            data-testid="ai-tab-subscription"
          >
            <span className="modal-tab-title">구독</span>
            <span className="modal-tab-hint">준비 중</span>
          </button>
        </div>

        <div className="ai-form">
          <label className="ai-field ai-field--wide">
            <span className="ai-label">프리셋</span>
            <select
              value={value.presetId}
              onChange={(event) => changePreset(event.target.value)}
              data-testid="ai-provider"
            >
              {AI_PRESETS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
              <option value="local">{AI_PROVIDER_LABEL.local}</option>
            </select>
          </label>

          <label className="ai-field">
            <span className="ai-label">모델</span>
            <input
              value={value.model}
              placeholder={preset?.defaultModel ?? '모델 이름'}
              onChange={(event) => props.onChange({ model: event.target.value })}
              disabled={!remote}
              data-testid="ai-model"
              spellCheck={false}
            />
          </label>

          <label className="ai-field ai-field--wide">
            <span className="ai-label">
              Endpoint <span className="ai-hint">(프리셋이 채움 · 로컬 서버·게이트웨이도 같은 경로)</span>
            </span>
            <input
              value={value.endpoint}
              placeholder={preset?.baseUrl ?? 'http://127.0.0.1:11434/v1'}
              onChange={(event) => props.onChange({ endpoint: event.target.value })}
              disabled={!remote}
              data-testid="ai-endpoint"
              spellCheck={false}
            />
          </label>

          {remote && keyless && (
            <p className="ai-note ai-field--wide" data-testid="ai-keyless-note">
              이 프리셋은 키가 필요 없습니다. 로컬 모델 서버에 바로 연결됩니다.
            </p>
          )}

          {remote && !keyless && hasKeychainKey && (
            <div className="ai-field ai-field--wide" data-testid="ai-key-saved">
              <span className="ai-label">API 키</span>
              <div className="ai-keychain-row">
                <span className="ai-keychain-saved">키체인에 저장됨</span>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={props.onEraseKeychain}
                  disabled={busy}
                  data-testid="ai-key-erase"
                  title="저장된 키는 다시 표시할 수 없습니다. 삭제만 가능합니다."
                >
                  삭제
                </button>
              </div>
            </div>
          )}

          {remote && !keyless && !hasKeychainKey && (
            <>
              <label className="ai-field ai-field--wide">
                <span className="ai-label">API 키</span>
                <input
                  type="password"
                  value={value.apiKey}
                  placeholder={
                    providerStatus?.hasEnvKey === true
                      ? '데몬 환경변수 키를 사용 중 (비워두면 그대로)'
                      : 'sk-… · 이 창의 메모리에만 있습니다'
                  }
                  onChange={(event) => props.onChange({ apiKey: event.target.value })}
                  data-testid="ai-key"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="ai-check ai-field--wide" data-testid="ai-key-save-wrap">
                <input
                  type="checkbox"
                  checked={value.saveToKeychain}
                  onChange={(event) => props.onChange({ saveToKeychain: event.target.checked })}
                  disabled={!keychainAvailable || value.apiKey.trim() === ''}
                  data-testid="ai-key-save"
                />
                <span>
                  이 컴퓨터 키체인에 저장{' '}
                  <span className="ai-hint">
                    {keychainAvailable
                      ? '(저장 후 키는 다시 표시되지 않습니다 · 삭제만 가능)'
                      : '(데스크톱 앱에서만 사용 가능)'}
                  </span>
                </span>
              </label>
            </>
          )}
        </div>

        {remote && !keyless && (
          <p className="ai-note ai-source" data-testid="ai-source-badge">
            키 우선순위: 지금 입력 키 &gt; 키체인 &gt; 환경변수 &gt; 로컬 규칙 폴백 · 지금:{' '}
            <strong>{effectiveSource}</strong>
          </p>
        )}

        <p className="ai-note" data-testid="ai-privacy-note">
          키는 SQLite·localStorage·로그에 저장하지 않습니다. 요청 한 번에 실려 모델로 가고
          데몬은 곧바로 잊습니다. 키체인 저장은 OS의 암호화 저장소에 맡기며, 앱은 쓰고 지울
          수만 있습니다. 모두 비우면 데몬 환경변수(
          <span className="mono">ANTHROPIC_API_KEY</span> ·{' '}
          <span className="mono">OPENAI_API_KEY</span>)를 씁니다.
        </p>

        <div className="ai-actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={props.onTest}
            disabled={busy || !props.sqliteMode}
            data-testid="ai-test"
          >
            연결 확인
          </button>
          <span
            className={`ai-status ai-status--${result === null ? 'idle' : result.tone}`}
            data-testid="ai-status"
            data-state={result === null ? 'idle' : result.tone === 'info' ? 'ok' : 'fail'}
          >
            {result === null ? '아직 확인하지 않았습니다' : result.text}
          </span>
        </div>

        <div className="ai-propose">
          <span className="ai-label">제안 추출</span>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => props.onPropose('graph')}
            disabled={busy || !props.sqliteMode}
            data-testid="ai-extract-graph"
            title="핀에서 요구사항·정책·계약·QA 초안을 뽑아 결정 카드 1장으로 만듭니다"
          >
            그래프 제안
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => props.onPropose('doc')}
            disabled={busy || !props.sqliteMode || !props.hasDoc}
            data-testid="ai-extract-doc"
            title={props.hasDoc ? '문단 patch 제안 1건' : '문서가 있어야 문단 제안을 만들 수 있습니다'}
          >
            문서 문단 제안
          </button>
        </div>

        {!props.sqliteMode && (
          <p className="ai-note ai-note--warn">
            LLM 제안 추출은 로컬 SQLite 데몬 모드에서만 동작합니다. 브라우저 임시 모드에서는
            <strong> 그래프 · RTM</strong> 탭의 <strong>핀에서 정책 · 요구사항 · QA 추출</strong>
            (로컬 규칙 폴백)을 쓰세요.
          </p>
        )}
      </section>
    </div>
  );
}
