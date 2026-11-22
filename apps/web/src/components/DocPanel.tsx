import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  BLOCK_TYPES,
  BLOCK_TYPE_LABEL,
  PIN_TYPE_LABEL,
  type Block,
  type BlockType,
  type Doc,
  type DocKind,
  type Pin,
  type Proposal,
} from '@spec-studio/protocol';
import { proseOf, staleForBlock, staleBadges } from '@spec-studio/core';
import { surfaceProps } from '../model/surfaces';

export type DocMode = 'direct' | 'proposal';

/** What the kind badge says; the schema holds the vocabulary, the panel the words. */
const DOC_KIND_LABEL: Record<DocKind, string> = {
  spec: '스펙',
  research: '리서치',
  backlog: '백로그',
};

export interface RevertableView {
  seq: number;
  at: string;
  summary: string;
  blocks: number;
  /** The `op_log.kind` the undo would take back (proposal adopts or doc ops). */
  op: string;
  /** For an adopt undo, which card it restores — null for doc lifecycle ops. */
  proposalId: string | null;
}

interface DocPanelProps {
  doc: Doc | null;
  /** The registry; one tab each, the active one is `doc`. */
  docs: Doc[];
  pins: Pin[];
  proposal: Proposal | null;
  mode: DocMode;
  selectedPinId: string | null;
  focusBlockId: string | null;
  revertable: RevertableView | null;
  /**
   * F3-3's research-side warning on the spec view: requirement nodes no
   * `references` link grounds with evidence. Empty list renders nothing.
   */
  ungrounded: Array<{ id: string; title: string }>;
  /**
   * The source of the card the last AI request filed, when that card is the
   * one on the table — doc proposals carry no llm/rule flag of their own.
   */
  sourceHint: { proposalId: string; source: 'llm' | 'rule' } | null;
  sqliteMode: boolean;
  busy: boolean;
  onMode: (mode: DocMode) => void;
  onSwitchDoc: (docId: string) => void;
  onCreateDoc: (title: string, kind: DocKind) => void;
  onDeleteDoc: (docId: string) => void;
  onRenameDoc: (docId: string, title: string) => void;
  onAddBlock: (afterBlockId: string | null) => void;
  onUpdateText: (blockId: string, text: string) => void;
  onChangeType: (blockId: string, type: BlockType) => void;
  onDeleteBlock: (blockId: string) => void;
  onMoveBlock: (blockId: string, afterBlockId: string | null) => void;
  onLinkPin: (blockId: string, pinId: string) => void;
  onUnlinkPin: (blockId: string, pinId: string) => void;
  onClearStale: (blockId: string, pinIds: string[]) => Promise<void>;
  onSelectPin: (pinId: string) => void;
  onCreateProposal: () => void;
  onAdopt: () => void;
  onReject: () => void;
  onRevert: () => void;
  onFocusHandled: () => void;
}

interface DocTabsProps {
  docs: Doc[];
  activeDocId: string | null;
  busy: boolean;
  revertable: RevertableView | null;
  onSwitch: (docId: string) => void;
  onCreate: (title: string, kind: DocKind) => void;
  onDelete: (docId: string) => void;
  onRename: (docId: string, title: string) => void;
  onRevert: () => void;
}

/** Doc lifecycle ops the tab bar can hand back to the ledger as an undo. */
const DOC_UNDO_OPS = new Set(['doc.create', 'doc.update', 'doc.delete']);

/**
 * One tab per document, plus the two registry moves the bar owns: make a doc,
 * delete the open one. Delete asks twice — the button arms itself first — so a
 * stray click cannot drop a document.
 */
function DocTabs(props: DocTabsProps) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<DocKind>('spec');
  const [armed, setArmed] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState('');

  // An armed delete or an open rename belongs to the tab it was pressed on,
  // never the next one.
  useEffect(() => {
    setArmed(false);
    setRenaming(false);
  }, [props.activeDocId]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed === '') return;
    props.onCreate(trimmed, kind);
    setCreating(false);
    setTitle('');
    setKind('spec');
  };

  // F-4 (v16): rename is a registry move like delete — one button on the tab
  // bar opens the inline form prefilled with the title on the doc.
  const startRename = () => {
    const active = props.docs.find((doc) => doc.id === props.activeDocId);
    if (active === undefined) return;
    setRenameTitle(active.title);
    setRenaming(true);
    setCreating(false);
  };

  const submitRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = renameTitle.trim();
    if (trimmed === '' || props.activeDocId === null) return;
    props.onRename(props.activeDocId, trimmed);
    setRenaming(false);
  };

  const removeActive = () => {
    if (props.activeDocId === null) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    props.onDelete(props.activeDocId);
  };

  return (
    <div className="doc-tabs-wrap">
      <div className="doc-tabs" role="tablist" aria-label="문서" data-testid="doc-tabs">
        {props.docs.map((doc) => (
          <button
            key={doc.id}
            type="button"
            role="tab"
            className={`doc-tab${doc.id === props.activeDocId ? ' is-active' : ''}`}
            aria-selected={doc.id === props.activeDocId}
            onClick={() => props.onSwitch(doc.id)}
            data-testid="doc-tab"
            data-id={doc.id}
            data-kind={doc.kind}
            title={doc.title}
          >
            <span className="doc-tab-title">{doc.title}</span>
            <span className={`doc-kind doc-kind--${doc.kind}`} data-testid="doc-kind">
              {DOC_KIND_LABEL[doc.kind]}
            </span>
          </button>
        ))}
        <button
          type="button"
          className="doc-tab doc-tab--add"
          aria-label="문서 추가"
          title="새 문서"
          disabled={props.busy}
          onClick={() => setCreating((open) => !open)}
          data-testid="doc-create"
        >
          +
        </button>
        {props.activeDocId !== null && (
          <button
            type="button"
            className="doc-tab doc-tab--rename"
            aria-label="문서 이름 변경"
            title="현재 문서 이름 변경"
            disabled={props.busy}
            onClick={startRename}
            data-testid="doc-rename"
          >
            ✎
          </button>
        )}
        {props.activeDocId !== null && (
          <button
            type="button"
            className={`doc-tab doc-tab--delete${armed ? ' is-armed' : ''}`}
            aria-label="문서 삭제"
            title={armed ? '한 번 더 누르면 이 문서를 지웁니다' : '현재 문서 삭제'}
            disabled={props.busy}
            onClick={removeActive}
            data-testid="doc-delete"
          >
            {armed ? '삭제?' : '휴지통'}
          </button>
        )}
        {props.revertable !== null &&
          DOC_UNDO_OPS.has(props.revertable.op) && (
            <button
              type="button"
              className="doc-tab doc-tab--undo"
              aria-label="문서 작업 되돌리기"
              title={props.revertable.summary}
              disabled={props.busy}
              onClick={props.onRevert}
              data-testid="doc-undo"
            >
              ↩ {props.revertable.summary}
            </button>
          )}
      </div>
      {creating && (
        <form className="doc-create-form" onSubmit={submit}>
          <input
            className="doc-create-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="문서 제목"
            aria-label="문서 제목"
            autoFocus
            data-testid="doc-create-title"
          />
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as DocKind)}
            aria-label="문서 종류"
            data-testid="doc-create-kind"
          >
            <option value="spec">스펙</option>
            <option value="research">리서치</option>
          </select>
          <button
            type="submit"
            className="btn btn--primary btn--sm"
            disabled={props.busy || title.trim() === ''}
            data-testid="doc-create-confirm"
          >
            만들기
          </button>
          <button type="button" className="btn btn--sm" onClick={() => setCreating(false)}>
            취소
          </button>
        </form>
      )}
      {renaming && (
        <form className="doc-create-form" onSubmit={submitRename}>
          <input
            className="doc-create-title"
            value={renameTitle}
            onChange={(event) => setRenameTitle(event.target.value)}
            placeholder="새 문서 제목"
            aria-label="새 문서 제목"
            autoFocus
            data-testid="doc-rename-input"
          />
          <button
            type="submit"
            className="btn btn--primary btn--sm"
            disabled={props.busy || renameTitle.trim() === ''}
            data-testid="doc-rename-confirm"
          >
            변경
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => setRenaming(false)}
            data-testid="doc-rename-cancel"
          >
            취소
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * The document side of the screen. Direct mode writes the blocks; proposal mode
 * shows what a single suggestion would change and waits for one decision. The
 * pin chips are the other half of the two-way link: pressing one selects that
 * pin on the canvas, and the pin panel's "참조 문단" list jumps back here.
 */
export function DocPanel(props: DocPanelProps) {
  const { doc, pins, proposal, mode, selectedPinId, focusBlockId, revertable } = props;
  const listRef = useRef<HTMLOListElement>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (focusBlockId === null) return;
    setFlash(focusBlockId);
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-block-id="${focusBlockId}"]`,
    );
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node?.focus({ preventScroll: true });
    const timer = window.setTimeout(() => {
      setFlash(null);
      props.onFocusHandled();
    }, 2400);
    return () => window.clearTimeout(timer);
  }, [focusBlockId]);

  if (doc === null) {
    return (
      <aside
        className="doc-panel"
        aria-label="문서"
        data-testid="doc-panel"
        {...surfaceProps('docPanel')}
      >
        <DocTabs
          docs={props.docs}
          activeDocId={null}
          busy={props.busy}
          revertable={props.sqliteMode ? props.revertable : null}
          onSwitch={props.onSwitchDoc}
          onCreate={props.onCreateDoc}
          onDelete={props.onDeleteDoc}
          onRename={props.onRenameDoc}
          onRevert={props.onRevert}
        />
        <p className="doc-empty">
          문서가 없습니다. <b>+</b> 버튼으로 첫 문서를 만들 수 있습니다.
        </p>
      </aside>
    );
  }

  const badges = staleBadges(doc, pins);
  const staleCount = badges.length;
  // A proposal belongs to the doc it was filed against; other tabs never see it.
  const ours = proposal !== null && proposal.docId === doc.id ? proposal : null;
  const proposalOpen = ours !== null && ours.state === 'open';
  const directEditable = mode === 'direct' && !props.busy;
  // The honest badge: what the daemon said filed this card wins; the origin
  // fallback keeps the old meaning (핀 추출 = rule, 그 외 = LLM 문안).
  const cardSource =
    ours !== null && props.sourceHint !== null && props.sourceHint.proposalId === ours.id
      ? props.sourceHint.source
      : ours?.origin === 'doc-chat'
        ? 'llm'
        : 'rule';


  return (
    <aside
      className="doc-panel"
      aria-label="문서"
      data-testid="doc-panel"
      {...surfaceProps('docPanel')}
    >
      <DocTabs
        docs={props.docs}
        activeDocId={doc.id}
        busy={props.busy}
        revertable={props.sqliteMode ? props.revertable : null}
        onSwitch={props.onSwitchDoc}
        onCreate={props.onCreateDoc}
        onDelete={props.onDeleteDoc}
        onRename={props.onRenameDoc}
        onRevert={props.onRevert}
      />

      <div className="panel-head doc-head">
        <span className="panel-title">
          <h2>{doc.title}</h2>
          <span className="panel-count" data-testid="doc-rev">
            rev {doc.rev}
          </span>
        </span>
        {staleCount > 0 && (
          <span className="stale-chip" data-testid="doc-stale-count">
            stale {staleCount}
          </span>
        )}
      </div>

      {doc.kind === 'spec' && props.ungrounded.length > 0 && (
        <div className="ungrounded-note" data-testid="req-ungrounded">
          <p className="ungrounded-count">근거 없는 요구사항 {props.ungrounded.length}건</p>
          <ul>
            {props.ungrounded.map((req) => (
              <li key={req.id} title={req.title}>
                {req.title}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="doc-mode" role="group" aria-label="편집 계층">
        <button
          type="button"
          className={`doc-mode-btn${mode === 'direct' ? ' is-active' : ''}`}
          aria-pressed={mode === 'direct'}
          onClick={() => props.onMode('direct')}
          data-testid="mode-direct"
        >
          직접 편집
        </button>
        <button
          type="button"
          className={`doc-mode-btn${mode === 'proposal' ? ' is-active' : ''}`}
          aria-pressed={mode === 'proposal'}
          onClick={() => props.onMode('proposal')}
          data-testid="mode-proposal"
        >
          제안 사용
        </button>
      </div>

      <div className="doc-scroll">
        {doc.blocks.length === 0 ? (
          <p className="doc-empty">
            아직 문단이 없습니다. <b>문단 추가</b>로 시작하고, 핀을 연결해 문단과 화면을
            잇습니다.
          </p>
        ) : (
          <ol className="doc-blocks" ref={listRef}>
            {doc.blocks.map((block, index) => (
              <BlockRow
                key={block.id}
                block={block}
                position={index + 1}
                pins={pins}
                doc={doc}
                editable={directEditable}
                selectedPinId={selectedPinId}
                flashed={flash === block.id}
                first={index === 0}
                onUpdateText={props.onUpdateText}
                onChangeType={props.onChangeType}
                onDelete={props.onDeleteBlock}
                onMove={props.onMoveBlock}
                onLinkPin={props.onLinkPin}
                onUnlinkPin={props.onUnlinkPin}
                onClearStale={props.onClearStale}
                onSelectPin={props.onSelectPin}
              />
            ))}
          </ol>
        )}

        {mode === 'direct' && (
          <button
            type="button"
            className="doc-add"
            onClick={() => props.onAddBlock(doc.blocks.at(-1)?.id ?? null)}
            disabled={props.busy}
            data-testid="doc-add"
          >
            + 문단 추가
          </button>
        )}
      </div>

      <div className="doc-foot">
        {mode === 'proposal' && (
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={props.onCreateProposal}
            disabled={props.busy}
            data-testid="proposal-create"
          >
            제안 만들기
          </button>
        )}

        {proposalOpen && (
          <section className="proposal-card" data-testid="proposal-card">
            <p className="proposal-eyebrow">
              제안 1건 · 결정 카드 1개
              <span
                className={`decision-source decision-source--${cardSource}`}
                data-testid="proposal-source"
                data-source={cardSource}
                title={
                  cardSource === 'llm'
                    ? '모델이 쓴 문단 patch입니다. 채택 전까지 본문은 그대로입니다.'
                    : '로컬 규칙이 만든 문단 patch입니다.'
                }
              >
                {cardSource === 'llm' ? 'LLM 제안' : '로컬 규칙'}
              </span>
            </p>
            <p className="proposal-summary" data-testid="proposal-summary">
              {ours.summary}
            </p>
            <ul className="proposal-patches">
              {ours.patches.map((patch) => (
                <li key={patch.blockId} data-testid="proposal-patch">
                  <span className={`patch-kind patch-kind--${patch.before === null ? 'add' : 'edit'}`}>
                    {patch.before === null ? '추가' : '수정'}
                  </span>
                  <span className="patch-before">
                    {patch.before === null ? '(새 문단)' : truncate(patch.before.text)}
                  </span>
                  <span className="patch-arrow">→</span>
                  <span className="patch-after">{truncate(patch.after.text)}</span>
                </li>
              ))}
            </ul>
            <div className="proposal-actions">
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={props.onAdopt}
                disabled={props.busy}
                data-testid="proposal-adopt"
              >
                채택
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={props.onReject}
                disabled={props.busy}
                data-testid="proposal-reject"
              >
                거절
              </button>
            </div>
          </section>
        )}

        {ours !== null && ours.state === 'adopted' && (
          <div className="adopted-bar" data-testid="adopted-bar">
            <span className="adopted-text">
              채택됨 · {truncate(ours.summary, 48)}
              {props.sqliteMode ? '' : ' (데몬 연결 시 되돌리기 가능)'}
            </span>
            {/* The button must restore *this* card: now that every command
                refreshes `revertable`, a later op can sit on top — undo it
                only when the ledger's next undo really is this adoption. */}
            {revertable !== null &&
              revertable.op === 'proposal.adopt' &&
              revertable.proposalId === ours.id && (
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={props.onRevert}
                  disabled={props.busy || !props.sqliteMode}
                  data-testid="proposal-revert"
                  title="op_log.before 스냅샷으로 채택 직전 문단 상태를 복원합니다"
                >
                  되돌리기
                </button>
              )}
          </div>
        )}

        {ours !== null && ours.state === 'rejected' && revertable === null && (
          <p className="doc-note" data-testid="reverted-note">
            마지막 제안은 채택되지 않았거나 되돌려졌습니다. 문단은 채택 이전 상태입니다.
          </p>
        )}
      </div>
    </aside>
  );
}

function truncate(text: string, size = 64): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > size ? `${flat.slice(0, size)}…` : flat;
}

interface BlockRowProps {
  block: Block;
  position: number;
  pins: Pin[];
  doc: Doc;
  editable: boolean;
  selectedPinId: string | null;
  flashed: boolean;
  first: boolean;
  onUpdateText: (blockId: string, text: string) => void;
  onChangeType: (blockId: string, type: BlockType) => void;
  onDelete: (blockId: string) => void;
  onMove: (blockId: string, afterBlockId: string | null) => void;
  onLinkPin: (blockId: string, pinId: string) => void;
  onUnlinkPin: (blockId: string, pinId: string) => void;
  onClearStale: (blockId: string, pinIds: string[]) => Promise<void>;
  onSelectPin: (pinId: string) => void;
}

function BlockRow(props: BlockRowProps) {
  const { block, pins, doc, editable } = props;
  const [text, setText] = useState(block.text);
  const [linkPin, setLinkPin] = useState('');

  useEffect(() => {
    setText(block.text);
  }, [block.text, block.id]);

  const stale = staleForBlock(doc, pins, block.id);
  const byId = new Map(pins.map((pin) => [pin.id, pin] as const));
  const index = doc.blocks.indexOf(block);
  const below = doc.blocks[index + 2]?.id ?? null;
  const canDown = doc.blocks[index + 1] !== undefined;
  const linkable = pins.filter(
    (pin) => !block.pinRefs.some((ref) => ref.pinId === pin.id),
  );

  const commit = () => {
    if (text !== block.text) props.onUpdateText(block.id, text);
  };

  return (
    <li
      className={`doc-block${stale.length > 0 ? ' is-stale' : ''}${
        props.flashed ? ' is-focused' : ''
      }`}
      data-testid={`doc-block-${props.position}`}
      data-block-id={block.id}
      data-stale={stale.length > 0}
      tabIndex={-1}
    >
      <div className="doc-block-head">
        <span className="doc-block-index">문단 {props.position}</span>
        <select
          className="doc-type"
          value={block.type}
          aria-label={`문단 ${props.position} 종류`}
          disabled={!editable}
          onChange={(event) => props.onChangeType(block.id, event.target.value as BlockType)}
          data-testid={`block-type-${props.position}`}
        >
          {BLOCK_TYPES.map((type) => (
            <option key={type} value={type}>
              {BLOCK_TYPE_LABEL[type]}
            </option>
          ))}
        </select>
        <div className="doc-block-tools">
          <button
            type="button"
            className="icon-btn"
            aria-label="위로 옮기기"
            title="한 칸 위로"
            disabled={!editable || props.first}
            onClick={() => props.onMove(block.id, doc.blocks[index - 2]?.id ?? null)}
            data-testid={`block-up-${props.position}`}
          >
            ↑
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="아래로 옮기기"
            title="한 칸 아래로"
            disabled={!editable || !canDown}
            onClick={() => canDown && props.onMove(block.id, below)}
            data-testid={`block-down-${props.position}`}
          >
            ↓
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="문단 삭제"
            title="문단 삭제"
            disabled={!editable}
            onClick={() => props.onDelete(block.id)}
            data-testid={`block-delete-${props.position}`}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3 4.5h10M6.5 4.5V3.2c0-.4.3-.7.7-.7h1.6c.4 0 .7.3.7.7v1.3M5 4.5l.6 8.1c0 .5.4.9.9.9h3c.5 0 .9-.4.9-.9l.6-8.1"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <textarea
        className="doc-text"
        value={text}
        readOnly={!editable}
        rows={Math.min(10, Math.max(2, text.split('\n').length + 1))}
        aria-label={`문단 ${props.position} 내용`}
        placeholder="문단을 씁니다. # 뒤에 핀을 연결하면 화면과 함께 움직입니다."
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        data-testid={`doc-text-${props.position}`}
      />

      <div className="doc-refs">
        {block.pinRefs.map((ref) => {
          const pin = byId.get(ref.pinId);
          return (
            <span key={ref.pinId} className="pin-chip-wrap">
              <button
                type="button"
                className={`pin-chip${pin !== undefined && pin.id === props.selectedPinId ? ' is-selected' : ''}`}
                onClick={() => pin !== undefined && props.onSelectPin(pin.id)}
                title={pin === undefined ? '삭제된 핀' : `${pin.title} · ${PIN_TYPE_LABEL[pin.type]}`}
                data-testid={`chip-${props.position}-${pin?.number ?? 'x'}`}
              >
                #{pin?.number ?? '?'}
                <span className="pin-chip-title">{pin?.title ?? '삭제된 핀'}</span>
              </button>
              {editable && (
                <button
                  type="button"
                  className="chip-x"
                  aria-label="핀 연결 해제"
                  onClick={() => props.onUnlinkPin(block.id, ref.pinId)}
                  data-testid={`chip-unlink-${props.position}-${pin?.number ?? 'x'}`}
                >
                  ×
                </button>
              )}
            </span>
          );
        })}

        {editable && linkable.length > 0 && (
          <select
            className="pin-link"
            value={linkPin}
            aria-label="핀 연결"
            onChange={(event) => {
              const value = event.target.value;
              setLinkPin('');
              if (value !== '') props.onLinkPin(block.id, value);
            }}
            data-testid={`link-select-${props.position}`}
          >
            <option value="">+ 핀 연결</option>
            {linkable.map((pin) => (
              <option key={pin.id} value={pin.id}>
                #{pin.number} {pin.title}
              </option>
            ))}
          </select>
        )}
        {block.pinRefs.length === 0 && !editable && (
          <span className="doc-muted">연결된 핀 없음</span>
        )}
      </div>

      {stale.length > 0 && (
        <div className="doc-stale" data-testid={`block-stale-${props.position}`}>
          <span>
            {stale
              .map((badge) => {
                const pin = byId.get(badge.pinId);
                const label = pin === undefined ? '#' : `#${pin.number}`;
                return badge.reason === 'pin-missing'
                  ? `${label} 핀이 삭제됨`
                  : `${label} 핀이 바뀜`;
              })
              .join(' · ')}
          </span>
          {editable && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void props.onClearStale(block.id, stale.map((badge) => badge.pinId))}
              data-testid={`stale-clear-${props.position}`}
              title="문장은 그대로 맞습니다 — 링크 기준을 지금 핀으로 다시 잡습니다"
            >
              확인 · 해제
            </button>
          )}
        </div>
      )}

      {proseOf(block.text) === '' && (
        <p className="doc-muted">본문이 비어 있습니다.</p>
      )}
    </li>
  );
}
