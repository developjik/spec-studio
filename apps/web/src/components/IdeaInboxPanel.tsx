import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Evidence, Idea } from '@spec-studio/protocol';
import { surfaceProps } from '../model/surfaces';


/**
 * The idea inbox (E1 §4 F2). Capture is the whole point: a thought, maybe a
 * link, stored in three seconds through one command — `idea.capture`. The
 * panel never writes a node or a doc; 승격 and 리서치 시작 are the two doors
 * out, and both are just commands fired in order by App.
 *
 * The desktop global shortcut opens the same modal the in-app button does
 * (빠른 캡처); in a plain browser the button is the only path, which is the
 * spec's "웹 실행 환경은 앱 내 빠른 추가만".
 */

export interface InboxCaptureInput {
  text: string;
  url: string;
}

interface IdeaInboxPanelProps {
  ideas: Idea[];
  /** The research board's rows, so the brief picker can cite them (F3-2). */
  evidence: Evidence[];
  busy: boolean;
  /** The brief request is in flight; the picker waits but stays visible. */
  briefBusy: boolean;
  sqliteMode: boolean;
  /** The quick-capture overlay; App owns it because the shortcut opens it. */
  captureOpen: boolean;
  onOpenCapture: () => void;
  onCloseCapture: () => void;
  onCapture: (input: InboxCaptureInput) => void;
  onArchive: (ideaId: string) => void;
  onPromote: (idea: Idea) => void;
  onRunBrief: (ideaId: string, evidenceIds: string[]) => void;
  /** E3: the idea becomes an agent run's task (daemon mode only). */
  onRunAgent: (ideaId: string) => void;
}

const STATE_LABEL: Record<Idea['state'], string> = {
  captured: '보관 전',
  promoted: '승격됨',
  archived: '보관됨',
};

/** Only `captured` ideas act; a decided idea is a record, not a row of buttons. */
const ACTIONABLE: Idea['state'] = 'captured';

export function IdeaInboxPanel(props: IdeaInboxPanelProps) {
  const { ideas, evidence, busy, briefBusy, captureOpen } = props;
  const [open, setOpen] = useState(true);
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [query, setQuery] = useState('');
  const [briefIdeaId, setBriefIdeaId] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const modalText = useRef<HTMLTextAreaElement>(null);

  // The quick-capture overlay exists to be typed in immediately.
  useEffect(() => {
    if (captureOpen) modalText.current?.focus();
  }, [captureOpen]);

  const newestFirst = [...ideas].reverse();
  const needle = query.trim().toLowerCase();
  const visible =
    needle === ''
      ? newestFirst
      : newestFirst.filter(
          (idea) =>
            idea.title.toLowerCase().includes(needle) ||
            idea.tags.some((tag) => tag.toLowerCase().includes(needle)),
        );

  // FTS is E2+; this is the list filter the spec asks for — 제목/태그.
  const captured = evidence.filter((row) => row.state === 'captured');
  const briefIdea = briefIdeaId === null ? null : ideas.find((idea) => idea.id === briefIdeaId) ?? null;
  const briefPicked = briefIdeaId === null ? [] : captured.filter((row) => picked.has(row.id));

  const submitQuickAdd = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed === '') return;
    props.onCapture({ text: trimmed, url });
    setText('');
    setUrl('');
  };

  const submitModal = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed === '') return;
    props.onCapture({ text: trimmed, url });
    setText('');
    setUrl('');
    props.onCloseCapture();
  };

  const startBrief = (idea: Idea) => {
    // The checkbox default is "every captured row", the spec's 전체 선택.
    setBriefIdeaId(idea.id);
    setPicked(new Set(captured.map((row) => row.id)));
  };
  const togglePicked = (evidenceId: string) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(evidenceId)) next.delete(evidenceId);
      else next.add(evidenceId);
      return next;
    });
  };

  return (
    <section
      className={`idea-inbox${open ? '' : ' is-collapsed'}`}
      aria-label="아이디어 인박스"
      data-testid="idea-inbox"
      {...surfaceProps('ideaInbox')}
    >
      <div className="panel-head">
        <span className="panel-title">
          <h2>인박스</h2>
          <span className="panel-count">{ideas.length}</span>
        </span>
        <span className="inbox-head-actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={props.onOpenCapture}
            disabled={busy}
            data-testid="idea-capture-open"
            title="빠른 캡처 — 데스크톱은 Cmd/Ctrl+Shift+I"
          >
            빠른 캡처
          </button>
          <button
            type="button"
            className="inbox-fold"
            aria-expanded={open}
            aria-label={open ? '인박스 접기' : '인박스 펼치기'}
            onClick={() => setOpen((value) => !value)}
            data-testid="idea-inbox-fold"
          >
            {open ? '▾' : '▸'}
          </button>
        </span>
      </div>

      {open && (
          <>
          <form className="inbox-add" onSubmit={submitQuickAdd} data-testid="idea-add">
            <textarea
              className="inbox-add-text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="떠오른 아이디어를 한 줄… (첫 줄이 제목이 됩니다)"
              rows={2}
              disabled={busy}
              data-testid="idea-add-text"
            />
            <input
              className="inbox-add-url"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="링크(선택) https://…"
              disabled={busy}
              data-testid="idea-add-url"
              spellCheck={false}
            />
            <button
              type="submit"
              className="btn btn--primary btn--sm"
              disabled={busy || text.trim() === ''}
              data-testid="idea-add-submit"
            >
              저장
            </button>
          </form>

          {ideas.length > 0 && (
            <div className="inbox-filter">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="제목·태그로 거르기"
                aria-label="아이디어 거르기"
                data-testid="idea-filter"
              />
            </div>
          )}

          {ideas.length === 0 ? (
            <p className="inbox-empty">
              아직 아이디어가 없습니다. 위 입력창이나 <b>빠른 캡처</b>로 첫 아이디어를 저장하세요.
            </p>
          ) : (
            <ul className="inbox-list">
              {visible.map((idea) => {
                const actionable = idea.state === ACTIONABLE;
                return (
                  <li
                    key={idea.id}
                    className={`inbox-row${idea.state === 'archived' ? ' is-archived' : ''}`}
                    data-testid="idea-item"
                    data-id={idea.id}
                    data-state={idea.state}
                  >
                    <div className="inbox-row-main">
                      <span className="inbox-title">{idea.title}</span>
                      <span className="inbox-tags">
                        {idea.tags.map((tag) => (
                          <span key={tag} className={`inbox-tag inbox-tag--${tag}`}>
                            {tag}
                          </span>
                        ))}
                        <span className={`inbox-state inbox-state--${idea.state}`}>
                          {STATE_LABEL[idea.state]}
                        </span>
                      </span>
                    </div>
                    {actionable && (
                      <div className="inbox-actions">
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={busy || briefBusy}
                          onClick={() => startBrief(idea)}
                          data-testid="idea-research"
                          title="이 아이디어로 리서치 브리프를 만듭니다"
                        >
                          리서치 시작
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={busy || briefBusy || !props.sqliteMode}
                          onClick={() => props.onRunAgent(idea.id)}
                          data-testid="idea-agent-run"
                          title={
                            props.sqliteMode
                              ? '이 아이디어로 에이전트 런을 시작합니다'
                              : '에이전트 런은 SQLite 데몬 모드에서만 동작합니다'
                          }
                        >
                          에이전트 런
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={busy}
                          onClick={() => props.onPromote(idea)}
                          data-testid="idea-promote"
                          title="새 스펙 문서를 만들고 아이디어를 승격 처리합니다"
                        >
                          스펙으로 승격
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={busy}
                          onClick={() => props.onArchive(idea.id)}
                          data-testid="idea-archive"
                        >
                          보관
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {briefIdea !== null && (
            <div className="brief-picker" data-testid="brief-picker">
              <p className="brief-picker-head">
                리서치 브리프 · <b>{briefIdea.title}</b>
              </p>
              {!props.sqliteMode && (
                <p className="brief-picker-note">SQLite 데몬 모드에서만 브리프를 만들 수 있습니다.</p>
              )}
              {captured.length === 0 ? (
                <p className="brief-picker-note">근거가 없으면 모든 주장에 근거 없음이 붙습니다.</p>
              ) : (
                <ul className="brief-evidence-list">
                  {captured.map((row) => (
                    <li key={row.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={picked.has(row.id)}
                          onChange={() => togglePicked(row.id)}
                          disabled={briefBusy}
                          data-testid="brief-evidence"
                          data-id={row.id}
                        />
                        <span>{row.title}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <div className="brief-picker-actions">
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={briefBusy || !props.sqliteMode}
                  onClick={() => props.onRunBrief(briefIdea.id, briefPicked.map((row) => row.id))}
                  data-testid="idea-brief"
                >
                  {briefBusy ? '만드는 중…' : '브리프 만들기'}
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={briefBusy}
                  onClick={() => setBriefIdeaId(null)}
                  data-testid="brief-cancel"
                >
                  취소
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {captureOpen && (
        <div className="modal-veil" onClick={props.onCloseCapture} data-testid="idea-capture-modal">
          <section
            className="modal inbox-capture-modal"
            role="dialog"
            aria-label="빠른 캡처"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="modal-head">
              <div className="modal-title">
                <h2>빠른 캡처</h2>
                <p>지금 떠오른 것을 인박스에 3초 안에 저장합니다</p>
              </div>
              <button
                type="button"
                className="btn btn--sm"
                onClick={props.onCloseCapture}
                data-testid="idea-capture-close"
              >
                닫기
              </button>
            </header>
            <form className="inbox-capture-form" onSubmit={submitModal}>
              <textarea
                ref={modalText}
                className="inbox-add-text"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="아이디어의 첫 줄이 제목이 됩니다"
                rows={4}
                disabled={busy}
                data-testid="idea-capture-text"
              />
              <input
                className="inbox-add-url"
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="링크(선택) https://…"
                disabled={busy}
                data-testid="idea-capture-url"
                spellCheck={false}
              />
              <div className="inbox-capture-actions">
                <button
                  type="submit"
                  className="btn btn--primary btn--sm"
                  disabled={busy || text.trim() === ''}
                  data-testid="idea-capture-submit"
                >
                  인박스에 저장
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
