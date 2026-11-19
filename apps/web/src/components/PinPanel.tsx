import {
  PIN_TYPE_LABEL,
  V1_PIN_TYPES,
  type Doc,
  type Pin,
  type PinType,
} from '@spec-studio/protocol';
import {
  blocksForPin,
  countByType,
  filterPins,
  missingPinNumbers,
  pinLabel,
  proseOf,
  type PinFilter,
} from '@spec-studio/core';
import { PinEditor, type PinEditInput } from './PinEditor';

interface PinPanelProps {
  pins: Pin[];
  /** The document, so a selected pin can list the paragraphs that cite it. */
  doc: Doc | null;
  onFocusBlock: (blockId: string) => void;
  filter: PinFilter;
  screenCode: string;
  nextNumber: number;
  pinSeq: number;
  selectedPinId: string | null;
  onFilter: (filter: PinFilter) => void;
  onSelect: (pinId: string) => void;
  onDelete: (pin: Pin) => void;
  onUpdate: (pinId: string, input: PinEditInput) => void;
  onCloseEditor: () => void;
}

export function PinPanel({
  pins,
  doc,
  onFocusBlock,
  filter,
  screenCode,
  nextNumber,
  pinSeq,
  selectedPinId,
  onFilter,
  onSelect,
  onDelete,
  onUpdate,
  onCloseEditor,
}: PinPanelProps) {
  const counts = countByType(pins);
  const visible = filterPins(pins, filter);
  const gaps = missingPinNumbers(pins, pinSeq);
  const allCount = pins.length;
  const selected = pins.find((pin) => pin.id === selectedPinId) ?? null;
  const citingBlocks =
    doc === null || selected === null ? [] : blocksForPin(doc, selected.id);

  return (
    <aside className="pin-panel" aria-label="핀 목록" data-testid="pin-panel">
      <div className="panel-head">
        <span className="panel-title">
          <h2>핀</h2>
          <span className="panel-count">{allCount}</span>
        </span>
        <span className="next-chip" data-testid="next-number">
          다음 #{nextNumber}
        </span>
      </div>

      {selected !== null && (
        <PinEditor
          key={selected.id}
          pin={selected}
          screenCode={screenCode}
          onSave={(input) => onUpdate(selected.id, input)}
          onClose={onCloseEditor}
        />
      )}

      {selected !== null && doc !== null && (
        <div className="pin-refs" data-testid="pin-ref-list">
          <p className="pin-refs-head">
            이 핀을 참조하는 문단 <span className="panel-count">{citingBlocks.length}</span>
          </p>
          {citingBlocks.length === 0 ? (
            <p className="pin-refs-empty">
              아직 없습니다. 문서의 문단에서 <b>+ 핀 연결</b>로 이 핀을 붙입니다.
            </p>
          ) : (
            <ul>
              {citingBlocks.map((block, index) => (
                <li key={block.id}>
                  <button
                    type="button"
                    className="pin-ref-row"
                    onClick={() => onFocusBlock(block.id)}
                    data-testid={`pin-ref-${index + 1}`}
                    data-block-id={block.id}
                  >
                    <span className="pin-ref-snippet">
                      {proseOf(block.text).trim() === ''
                        ? '(빈 문단)'
                        : proseOf(block.text).trim().slice(0, 70)}
                    </span>
                    <span className="pin-ref-jump">문단 보기 →</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="filters" role="group" aria-label="핀 타입 필터">
        <button
          type="button"
          className={`filter${filter === 'all' ? ' is-active' : ''}`}
          aria-pressed={filter === 'all'}
          onClick={() => onFilter('all')}
        >
          전체
          <span className="n">{allCount}</span>
        </button>
        {V1_PIN_TYPES.map((type: PinType) => (
          <button
            key={type}
            type="button"
            className={`filter${filter === type ? ' is-active' : ''}`}
            aria-pressed={filter === type}
            onClick={() => onFilter(type)}
            data-testid={`filter-${type}`}
          >
            {PIN_TYPE_LABEL[type]}
            <span className="n">{counts[type]}</span>
          </button>
        ))}
      </div>

      {allCount === 0 ? (
        <div className="panel-empty">
          <strong>아직 핀이 없습니다</strong>
          화면을 클릭해 첫 핀을 찍으세요. 번호는 #1부터 부여됩니다.
        </div>
      ) : visible.length === 0 ? (
        <div className="panel-empty">
          <strong>이 타입의 핀이 없습니다</strong>
          필터를 &lsquo;전체&rsquo;로 바꾸면 {allCount}개가 보입니다.
        </div>
      ) : (
        <ul className="pin-list">
          {visible.map((pin) => (
            <li
              key={pin.id}
              className={`pin-row${pin.id === selectedPinId ? ' is-selected' : ''}`}
              data-selected={pin.id === selectedPinId}
            >
              <button
                type="button"
                className="pin-row-main"
                onClick={() => onSelect(pin.id)}
                data-testid={`pin-row-${pin.number}`}
                data-selected={pin.id === selectedPinId}
              >
                <span className={`num num--${pin.type}`}>{pin.number}</span>
                <span className="pin-text">
                  <span className="pin-meta">
                    <span className={`type type--${pin.type}`}>{PIN_TYPE_LABEL[pin.type]}</span>
                    <span className="pin-code">{pinLabel(screenCode, pin.number)}</span>
                  </span>
                  <span className="pin-title">{pin.title}</span>
                  {pin.body !== '' && <span className="pin-body">{pin.body}</span>}
                </span>
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={`핀 ${pin.number} 삭제`}
                title={`핀 ${pin.number} 삭제 — 번호는 결번으로 남습니다`}
                onClick={() => onDelete(pin)}
                data-testid={`pin-delete-${pin.number}`}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M3 4.5h10M6.5 4.5V3.2c0-.4.3-.7.7-.7h1.6c.4 0 .7.3.7.7v1.3M5 4.5l.6 8.1c0 .5.4.9.9.9h3c.5 0 .9-.4.9-.9l.6-8.1"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="panel-foot">
        {gaps.length > 0 && (
          <p className="gaps" data-testid="gaps">
            결번 <b>{gaps.map((number) => `#${number}`).join(', ')}</b> · 번호는 다시 쓰지 않습니다
          </p>
        )}
        <p className="panel-rule">
          핀 번호는 삭제해도 당겨지지 않습니다. 새 핀은 항상 {nextNumber}번을 받습니다.
        </p>
      </div>
    </aside>
  );
}
