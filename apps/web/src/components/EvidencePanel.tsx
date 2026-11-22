import { useState, type FormEvent } from 'react';
import {
  EVIDENCE_EXCERPT_MAX,
  EVIDENCE_TYPES,
  type Evidence,
  type EvidenceType,
} from '@spec-studio/protocol';
import { surfaceProps } from '../model/surfaces';

/**
 * The research board's evidence sidebar (E1 §4 F3-4). It rides the research
 * document: clips come in as `evidence.capture`, leave as `evidence.dismiss`,
 * and become grounding through the same `link.create` the graph already
 * speaks — `references` from a requirement to a row. The excerpt ceiling is
 * R6's 짧은 인용 원칙; the 안내 문구 under the box says the same to a person.
 */

const TYPE_LABEL: Record<EvidenceType, string> = {
  web: '웹',
  pdf: 'PDF',
  image: '이미지',
  text: '텍스트',
};

const STATE_LABEL: Record<Evidence['state'], string> = {
  captured: '수집됨',
  cited: '인용됨',
  dismissed: '기각됨',
};

export interface EvidenceClipInput {
  url: string;
  title: string;
  excerpt: string;
  evidenceType: EvidenceType;
}

export interface EvidenceReqOption {
  id: string;
  title: string;
  ungrounded: boolean;
}

interface EvidencePanelProps {
  evidence: Evidence[];
  /** Requirement nodes, 미근거 first — the honest default for 근거로 연결. */
  requirements: EvidenceReqOption[];
  busy: boolean;
  onCapture: (input: EvidenceClipInput) => void;
  onDismiss: (evidenceId: string) => void;
  onLink: (srcNodeId: string, evidenceId: string) => void;
}

/** `https://example.com/a?b` → `example.com`; anything else stays raw. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function EvidencePanel(props: EvidencePanelProps) {
  const { evidence, requirements, busy } = props;
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [evidenceType, setEvidenceType] = useState<EvidenceType>('web');
  /** Which requirement each row's 연결 select points at, by evidence id. */
  const [targets, setTargets] = useState<Record<string, string>>({});

  const newestFirst = [...evidence].reverse();
  const orderedReqs = [
    ...requirements.filter((req) => req.ungrounded),
    ...requirements.filter((req) => !req.ungrounded),
  ];
  const defaultTarget = orderedReqs[0]?.id ?? '';

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanUrl = url.trim();
    if (cleanUrl === '') return;
    props.onCapture({
      url: cleanUrl,
      title: title.trim(),
      excerpt: excerpt.slice(0, EVIDENCE_EXCERPT_MAX),
      evidenceType,
    });
    setUrl('');
    setTitle('');
    setExcerpt('');
    setEvidenceType('web');
  };

  return (
    <aside
      className="evidence-panel"
      aria-label="근거"
      data-testid="evidence-panel"
      {...surfaceProps('evidencePanel')}
    >
      <div className="panel-head">
        <span className="panel-title">
          <h2>근거</h2>
          <span className="panel-count">{evidence.length}</span>
        </span>
      </div>

      <form className="evidence-add" onSubmit={submit} data-testid="evidence-add">
        <input
          className="evidence-add-url"
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="출처 URL https://…"
          aria-label="출처 URL"
          disabled={busy}
          data-testid="evidence-add-url"
          spellCheck={false}
        />
        <input
          className="evidence-add-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="제목(선택 — 비우면 URL에서 만듭니다)"
          aria-label="근거 제목"
          disabled={busy}
          data-testid="evidence-add-title"
        />
        <textarea
          className="evidence-add-excerpt"
          value={excerpt}
          onChange={(event) => setExcerpt(event.target.value.slice(0, EVIDENCE_EXCERPT_MAX))}
          placeholder="발췌 — 짧은 인용만 붙여넣습니다"
          aria-label="발췌"
          rows={3}
          disabled={busy}
          data-testid="evidence-add-excerpt"
        />
        <p className="evidence-add-note">
          짧은 인용 원칙 — 전문 복사 금지 · {EVIDENCE_EXCERPT_MAX.toLocaleString()}자 상한 (
          {excerpt.length}/{EVIDENCE_EXCERPT_MAX})
        </p>
        <div className="evidence-add-row">
          <select
            value={evidenceType}
            onChange={(event) => setEvidenceType(event.target.value as EvidenceType)}
            aria-label="근거 유형"
            disabled={busy}
            data-testid="evidence-add-type"
          >
            {EVIDENCE_TYPES.map((type) => (
              <option key={type} value={type}>
                {TYPE_LABEL[type]}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="btn btn--primary btn--sm"
            disabled={busy || url.trim() === ''}
            data-testid="evidence-add-submit"
          >
            클립 추가
          </button>
        </div>
      </form>

      {evidence.length === 0 ? (
        <p className="evidence-empty">
          아직 근거가 없습니다. 조사 중 만난 URL과 발췌를 클립으로 쌓습니다.
        </p>
      ) : (
        <ul className="evidence-list">
          {newestFirst.map((row) => {
            const target = targets[row.id] ?? defaultTarget;
            const dismissed = row.state === 'dismissed';
            return (
              <li
                key={row.id}
                className={`evidence-row${dismissed ? ' is-dismissed' : ''}`}
                data-testid="evidence-item"
                data-id={row.id}
                data-state={row.state}
                data-type={row.type}
              >
                <div className="evidence-row-main">
                  <span className="evidence-title">{row.title}</span>
                  <span className="evidence-meta">
                    <span className={`evidence-type evidence-type--${row.type}`}>
                      {TYPE_LABEL[row.type]}
                    </span>
                    <a
                      className="evidence-host"
                      href={row.url}
                      target="_blank"
                      rel="noreferrer"
                      title={row.url}
                    >
                      {hostOf(row.url)}
                    </a>
                    <span className={`evidence-state evidence-state--${row.state}`}>
                      {STATE_LABEL[row.state]}
                    </span>
                  </span>
                  {row.excerpt !== '' && <p className="evidence-excerpt">{row.excerpt}</p>}
                </div>
                {!dismissed && (
                  <div className="evidence-actions">
                    {orderedReqs.length > 0 && (
                      <span className="evidence-link-row">
                        <select
                          value={target}
                          onChange={(event) =>
                            setTargets((current) => ({ ...current, [row.id]: event.target.value }))
                          }
                          aria-label="연결할 요구사항"
                          disabled={busy}
                          data-testid="evidence-link-target"
                        >
                          {orderedReqs.map((req) => (
                            <option key={req.id} value={req.id}>
                              {`${req.ungrounded ? '⚠ ' : ''}${req.title}`}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={busy || target === ''}
                          onClick={() => props.onLink(target, row.id)}
                          data-testid="evidence-link"
                          title="references 링크로 이 요구사항의 근거로 연결합니다"
                        >
                          근거로 연결
                        </button>
                      </span>
                    )}
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={busy}
                      onClick={() => props.onDismiss(row.id)}
                      data-testid="evidence-dismiss"
                    >
                      기각
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="panel-foot">
        <p className="panel-rule">근거는 references 링크로 요구사항에 붙습니다. 인용되면 출처로 표시됩니다.</p>
      </div>
    </aside>
  );
}
