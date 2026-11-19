import {
  AI_DEFAULT_MODELS,
  AI_PROVIDERS,
  AI_PROVIDER_LABEL,
  type AiProposalMode,
  type AiProvider,
} from '@spec-studio/protocol';
import type { AiStatusView } from '../model/daemon';

/**
 * AI 설정.
 *
 * A provider, a model, an optional endpoint and a key. Nothing here is saved:
 * the fields live in the window for as long as the tab does, the key is sent
 * with one request and dropped by the daemon. The panel says so in one line
 * instead of hiding it — the promise is the product, not a footnote.
 *
 * The same panel proposes, because a person who has just typed an endpoint
 * wants to see what it drafts without hunting for another button.
 */

export interface AiSettingsValue {
  provider: AiProvider;
  model: string;
  endpoint: string;
  apiKey: string;
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
  onPropose: (mode: AiProposalMode) => void;
  onClose: () => void;
}

export function AiSettingsModal(props: AiSettingsModalProps) {
  const { value, status, busy, result } = props;
  const remote = value.provider !== 'local';
  const providerStatus = status?.providers.find((entry) => entry.provider === value.provider) ?? null;
  const placeholderModel = AI_DEFAULT_MODELS[value.provider];

  const changeProvider = (provider: AiProvider) => {
    props.onChange({
      provider,
      model: provider === value.provider ? value.model : AI_DEFAULT_MODELS[provider],
      endpoint: provider === 'openai' ? 'http://127.0.0.1:11434/v1' : '',
    });
  };

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
            <p>AI 설정 · 키는 이 창의 메모리에만 있습니다</p>
          </div>
          <button type="button" className="btn btn--sm" onClick={props.onClose} data-testid="ai-close">
            닫기
          </button>
        </header>

        <div className="ai-form">
          <label className="ai-field">
            <span className="ai-label">프로바이더</span>
            <select
              value={value.provider}
              onChange={(event) => changeProvider(event.target.value as AiProvider)}
              data-testid="ai-provider"
            >
              {AI_PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>
                  {AI_PROVIDER_LABEL[provider]}
                </option>
              ))}
            </select>
          </label>

          <label className="ai-field">
            <span className="ai-label">모델</span>
            <input
              value={value.model}
              placeholder={placeholderModel === '' ? '모델 이름' : placeholderModel}
              onChange={(event) => props.onChange({ model: event.target.value })}
              disabled={!remote}
              data-testid="ai-model"
              spellCheck={false}
            />
          </label>

          <label className="ai-field ai-field--wide">
            <span className="ai-label">
              Endpoint <span className="ai-hint">(비우면 기본 주소 · 로컬 서버도 가능)</span>
            </span>
            <input
              value={value.endpoint}
              placeholder={
                value.provider === 'anthropic'
                  ? 'https://api.anthropic.com'
                  : 'http://127.0.0.1:11434/v1'
              }
              onChange={(event) => props.onChange({ endpoint: event.target.value })}
              disabled={!remote}
              data-testid="ai-endpoint"
              spellCheck={false}
            />
          </label>

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
              disabled={!remote}
              data-testid="ai-key"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>

        <p className="ai-note" data-testid="ai-privacy-note">
          키는 SQLite·localStorage·로그에 저장하지 않습니다. 요청 한 번에 실려 모델로 가고
          데몬은 곧바로 잊습니다. 비워두면 데몬 환경변수(
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
            제안 추출은 SQLite 데몬 모드에서만 동작합니다. 데몬을 실행한 뒤 다시 열어 주세요.
          </p>
        )}
      </section>
    </div>
  );
}
