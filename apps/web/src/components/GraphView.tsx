import {
  GRAPH_LINK_LABEL,
  GRAPH_LINK_TYPES,
  NODE_TYPE_BADGE,
  NODE_TYPE_LABEL,
  type EditableNodeType,
  type GraphLinkType,
  type GraphNodeType,
  type Project,
} from '@spec-studio/protocol';
import {
  nodeStateOptions,
  type GraphViewNode,
  type Maturity,
  type TraceabilityReport,
} from '@spec-studio/core';
import { useState } from 'react';

/**
 * The graph surface: the project screens, their pins, and what a spec owes them. The three
 * columns answer three questions in order — what exists, how it is joined, and
 * what is still unowned. Nothing here edits pins; a pin is born in the studio
 * and arrives here as a node, which is what keeps one writer per object.
 */

interface GraphViewProps {
  project: Project;
  nodes: GraphViewNode[];
  report: TraceabilityReport;
  screenReport?: TraceabilityReport;
  maturity: Maturity;
  busy: boolean;
  selectedId: string | null;
  revertable: { seq: number; summary: string; nodes: number } | null;
  onSelect: (nodeId: string | null) => void;
  onCreateNode: (type: EditableNodeType, title: string, body: string) => void;
  onUpdateNode: (nodeId: string, patch: { title?: string; body?: string; state?: string }) => void;
  onDeleteNode: (nodeId: string) => void;
  onCreateLink: (type: GraphLinkType, src: string, dst: string) => void;
  onDeleteLink: (linkId: string) => void;
  onAckLink: (linkId: string) => void;
  onProposal: () => void;
  onAdopt: () => void;
  onReject: () => void;
  onRevert: () => void;
}

const COLUMNS: GraphNodeType[][] = [
  ['screen', 'pin'],
  ['req', 'policy'],
  ['contract', 'qa'],
];

const COLUMN_X = [24, 330, 636];
const COLUMN_W = 270;
const ROW_H = 58;

const STATE_LABEL: Record<string, string> = {
  draft: '초안',
  approved: '승인',
  building: '구현중',
  verified: '검증됨',
  agreed: '합의',
  applied: '적용',
  superseded: '대체됨',
  pass: '통과',
  fail: '실패',
  blocked: '미실행',
};

function typeOfNode(nodes: GraphViewNode[], id: string): GraphNodeType | null {
  return nodes.find((node) => node.id === id)?.type ?? null;
}

export function GraphView(props: GraphViewProps) {
  const { project, nodes, report, maturity, busy, selectedId, revertable } = props;
  const selected = nodes.find((node) => node.id === selectedId) ?? null;
  const [draftType, setDraftType] = useState<EditableNodeType>('req');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [linkType, setLinkType] = useState<GraphLinkType>('implements');
  const [linkTarget, setLinkTarget] = useState('');

  const proposal = project.graphProposal;
  // The last decision stays on screen: a person must be able to see what was
  // adopted (and take it back) after the card's buttons were pressed.
  const showProposal = proposal !== null;

  // One row per node inside a lane: two nodes of different types share the
  // lane, so the row counter belongs to the column, not to the type.
  const positions = new Map<string, { x: number; y: number }>();
  COLUMNS.forEach((types, columnIndex) => {
    const inColumn = types.flatMap((type) => nodes.filter((node) => node.type === type));
    inColumn.forEach((node, rowIndex) => {
      positions.set(node.id, { x: COLUMN_X[columnIndex]!, y: 34 + rowIndex * ROW_H });
    });
  });

  // The canvas is only as tall as the fullest lane: empty space reads as
  // missing content, and a traceability view must not look half-empty.
  const rowsPerColumn = COLUMNS.map(
    (types) => types.reduce((sum, type) => sum + nodes.filter((node) => node.type === type).length, 0),
  );
  const canvasHeight = Math.max(170, 24 + Math.max(...rowsPerColumn, 1) * ROW_H + 18);

  const selectedLinks = selected === null
    ? []
    : project.graph.links.filter((link) => link.src === selected.id || link.dst === selected.id);

  const addNode = () => {
    const title = draftTitle.trim();
    if (title === '') return;
    props.onCreateNode(draftType, title, draftBody);
    setDraftTitle('');
    setDraftBody('');
  };

  return (
    <main className="graph-view" data-testid="graph-view">
      <section className="graph-board">
        <div className="graph-head">
          <div>
            <h2 className="graph-title">객체 그래프 · 추적(RTM)</h2>
            <p className="graph-sub">
              화면·핀·요구사항·정책·계약·QA 여섯 타입을 일곱 링크로 잇습니다. 미연결 핀과 확인이
              필요한 링크는 오른쪽에 모입니다.
            </p>
          </div>
          <div className="graph-counts">
            <span className="count-chip" data-testid="graph-node-count">
              노드 {nodes.length}
            </span>
            <span className="count-chip" data-testid="graph-link-count">
              링크 {project.graph.links.length}
            </span>
            <span
              className={`count-chip${(props.screenReport??report).orphanPins.length > 0 ? ' count-chip--warn' : ''}`}
              data-testid="graph-orphan-pins"
            >
              고아 핀 {(props.screenReport??report).orphanPins.length}
            </span>
            <span
              className={`count-chip${report.suspectLinks.length > 0 ? ' count-chip--warn' : ''}`}
              data-testid="graph-suspect"
            >
              확인 필요 링크 {report.suspectLinks.length}
            </span>
            <span className="count-chip" data-testid="graph-coverage">
              추적률 {Math.round(report.coverage * 100)}%
            </span>
          </div>
        </div>

        <div className="graph-canvas-wrap">
          <svg
            className="graph-canvas"
            viewBox={`0 0 930 ${canvasHeight}`}
            role="img"
            aria-label="여섯 타입 객체와 일곱 링크의 추적 그래프"
            data-testid="graph-canvas"
          >
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#8b93a7" />
              </marker>
            </defs>
            {COLUMNS.map((_types, index) => (
              <g key={index}>
                <rect
                  x={COLUMN_X[index]! - 10}
                  y={6}
                  width={COLUMN_W + 20}
                  height={canvasHeight - 12}
                  rx={14}
                  className="graph-lane"
                />
                <text x={COLUMN_X[index]!} y={22} className="graph-lane-label">
                  {index === 0 ? '화면 · 핀' : index === 1 ? '요구사항 · 정책' : '계약 · QA'}
                </text>
              </g>
            ))}

            {project.graph.links.map((link) => {
              const from = positions.get(link.src);
              const to = positions.get(link.dst);
              if (from === undefined || to === undefined) return null;
              const x1 = from.x + COLUMN_W - 18;
              const y1 = from.y + 20;
              const x2 = to.x + 18;
              const y2 = to.y + 20;
              const mid = (x1 + x2) / 2;
              return (
                <path
                  key={link.id}
                  d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                  className={`graph-edge${link.suspectSince === null ? '' : ' graph-edge--suspect'}`}
                  markerEnd="url(#arrow)"
                  data-testid={`g-edge-${link.id}`}
                />
              );
            })}

            {nodes.map((node) => {
              const at = positions.get(node.id);
              if (at === undefined) return null;
              const orphan = (props.screenReport??report).orphanPins.includes(node.id) || report.orphanNodes.includes(node.id);
              return (
                <g
                  key={node.id}
                  transform={`translate(${at.x}, ${at.y})`}
                  className={`graph-node graph-node--${node.type}${orphan ? ' graph-node--orphan' : ''}${selectedId === node.id ? ' is-selected' : ''}`}
                  onClick={() => props.onSelect(selectedId === node.id ? null : node.id)}
                  data-testid={`g-node-${node.id}`}
                  role="button"
                  tabIndex={0}
                >
                  <rect width={COLUMN_W - 18} height={44} rx={9} className="graph-node-box" />
                  <rect width={4} height={44} rx={2} className="graph-node-stripe" />
                  <text x={12} y={17} className="graph-node-badge">
                    {NODE_TYPE_BADGE[node.type]}
                    {node.detail === null ? '' : ` · ${node.detail}`}
                  </text>
                  <text x={12} y={33} className="graph-node-title">
                    {node.title.length > 22 ? `${node.title.slice(0, 21)}…` : node.title}
                  </text>
                </g>
              );
            })}
          </svg>
          {project.graph.links.length === 0 && (
            <p className="graph-empty" data-testid="graph-empty">
              아직 링크가 없습니다. 오른쪽 아래에서 요구사항·정책·QA를 추가하거나, 핀에서 초안을
              추출해 한 번에 연결하세요.
            </p>
          )}
        </div>
      </section>

      <aside className="graph-side">
        {showProposal && proposal !== null && (
          <section className="decision-card" data-testid="graph-proposal-card">
            <header className="decision-head">
              <span className="decision-kicker">AI 제안 · 결정 카드</span>
              <span
                className={`decision-source decision-source--${proposal.source ?? 'rule'}`}
                data-testid="graph-proposal-source"
                data-source={proposal.source ?? 'rule'}
                title={
                  proposal.source === 'llm'
                    ? `${proposal.provider ?? ''}${proposal.model === null || proposal.model === undefined ? '' : ` · ${proposal.model}`} 가 만든 초안입니다. 본문은 채택 전까지 그대로입니다.`
                    : 'API 키 없이 로컬 규칙으로 만든 초안입니다. 키를 넣으면 LLM 제안을 씁니다.'
                }
              >
                {proposal.source === 'llm' ? 'LLM 제안' : '로컬 규칙 폴백'}
                {proposal.source === 'llm' && proposal.provider !== null && (
                  <span className="decision-source-model">
                    {proposal.provider}
                    {proposal.model === null || proposal.model === undefined ? '' : ` · ${proposal.model}`}
                  </span>
                )}
              </span>
              <span className={`decision-state decision-state--${proposal.state}`}>
                {proposal.state === 'open' ? '결정 대기' : proposal.state === 'adopted' ? '채택됨' : proposal.state}
              </span>
            </header>
            <p className="decision-summary" data-testid="graph-proposal-summary">
              {proposal.summary}
            </p>
            <ul className="decision-items" data-testid="graph-proposal-items">
              {proposal.nodes.map((node) => (
                <li key={node.key} data-testid="graph-proposal-item">
                  <span className={`mini-badge mini-badge--${node.type}`}>
                    {NODE_TYPE_LABEL[node.type]}
                  </span>
                  <span className="decision-item-title">{node.title}</span>
                  {node.pinId !== null && (
                    <span className="decision-item-source">핀에서</span>
                  )}
                </li>
              ))}
            </ul>
            <p className="decision-links" data-testid="graph-proposal-links">
              링크 {proposal.links.length}개를 함께 만듭니다 · 채택 후 한 번에 되돌릴 수 있습니다
            </p>
            {proposal.state === 'open' ? (
              <div className="decision-actions">
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={busy || proposal.nodes.length === 0}
                  onClick={props.onAdopt}
                  data-testid="graph-proposal-adopt"
                >
                  채택해 일괄 생성
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy}
                  onClick={props.onReject}
                  data-testid="graph-proposal-reject"
                >
                  거절
                </button>
              </div>
            ) : (
              <div className="decision-actions">
                {revertable !== null && revertable.seq > 0 && (
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={busy}
                    onClick={props.onRevert}
                    data-testid="graph-proposal-revert"
                  >
                    채택 되돌리기 ({revertable.nodes}개)
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy}
                  onClick={props.onProposal}
                  data-testid="graph-proposal-again"
                >
                  다시 추출
                </button>
              </div>
            )}
          </section>
        )}

        <button
          type="button"
          className="btn btn--primary graph-suggest"
          onClick={props.onProposal}
          disabled={busy || project.pins.length === 0}
          data-testid="graph-suggest"
          title="화면의 핀에서 정책·요구사항·QA 초안과 링크를 읽습니다"
        >
          핀에서 정책 · 요구사항 · QA 추출
        </button>

        <section className="graph-panel" data-testid="graph-add">
          <h3 className="graph-panel-title">객체 추가</h3>
          <div className="graph-form">
            <select
              value={draftType}
              onChange={(event) => setDraftType(event.target.value as EditableNodeType)}
              data-testid="graph-node-type"
              aria-label="객체 타입"
            >
              <option value="req">요구사항</option>
              <option value="policy">정책</option>
              <option value="contract">계약</option>
              <option value="qa">QA</option>
            </select>
            <input
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              placeholder="제목"
              data-testid="graph-node-title"
            />
            <textarea
              value={draftBody}
              onChange={(event) => setDraftBody(event.target.value)}
              placeholder="본문 (조건·수용 기준)"
              rows={2}
              data-testid="graph-node-body"
            />
            <button
              type="button"
              className="btn btn--sm"
              onClick={addNode}
              disabled={busy || draftTitle.trim() === ''}
              data-testid="graph-node-add"
            >
              추가
            </button>
          </div>
        </section>

        <section className="graph-panel" data-testid="graph-trace">
          <h3 className="graph-panel-title">추적 확인</h3>
          <p className="trace-line" data-testid="trace-orphan-nodes">
            연결 없는 객체 <strong>{report.orphanNodes.length}</strong>개
            {report.orphanNodes.length > 0 && (
              <span className="trace-list">
                {report.orphanNodes.slice(0, 4).map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="trace-jump"
                    onClick={() => props.onSelect(id)}
                  >
                    {nodes.find((node) => node.id === id)?.title ?? id}
                  </button>
                ))}
              </span>
            )}
          </p>
          <p className="trace-line" data-testid="trace-orphan-pins">
            연결 없는 핀 <strong>{(props.screenReport??report).orphanPins.length}</strong>개
            {(props.screenReport??report).orphanPins.length > 0 && (
              <span className="trace-list">
                {(props.screenReport??report).orphanPins.slice(0, 4).map((id) => {
                  const pin = nodes.find((node) => node.id === id);
                  return (
                    <button key={id} type="button" className="trace-jump" onClick={() => props.onSelect(id)}>
                      {pin?.detail ?? '#'} {pin?.title ?? ''}
                    </button>
                  );
                })}
              </span>
            )}
          </p>
          {report.suspectLinks.length > 0 && (
            <ul className="suspect-list" data-testid="suspect-list">
              {report.suspectLinks.map((link) => (
                <li key={link.id} data-testid={`suspect-${link.id}`}>
                  <span>
                    {GRAPH_LINK_LABEL[link.type]} · {nodes.find((node) => node.id === link.src)?.title} →{' '}
                    {nodes.find((node) => node.id === link.dst)?.title}
                    {link.suspectWhy === 'pin-changed' ? ' (핀이 바뀜)' : ''}
                  </span>
                  <button
                    type="button"
                    className="btn btn--xs"
                    onClick={() => props.onAckLink(link.id)}
                    data-testid={`suspect-ack-${link.id}`}
                  >
                    확인
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="trace-line trace-line--next" data-testid="maturity-next">
            다음 단계 {maturity.next?.level ?? '없음'} ·{' '}
            {maturity.todo.length === 0 ? '준비 완료' : maturity.todo.map((check) => check.label).join(' / ')}
          </p>
        </section>

        {selected !== null && (
          <section className="graph-panel graph-selected" data-testid="graph-selected">
            <header className="graph-selected-head">
              <span className={`mini-badge mini-badge--${selected.type}`}>
                {NODE_TYPE_LABEL[selected.type]}
              </span>
              <span className="mono graph-selected-id">{selected.id}</span>
            </header>
            {selected.type === 'screen' || selected.type === 'pin' ? (
              <p className="graph-readonly">
                {selected.type === 'pin'
                  ? '핀의 제목과 본문은 작업실의 핀 패널에서 고칩니다. 여기서는 연결만 다룹니다.'
                  : '화면은 작업실에서 등록합니다. 여기서는 연결만 다룹니다.'}
              </p>
            ) : (
              <div className="graph-form">
                <input
                  defaultValue={selected.title}
                  key={`title-${selected.id}`}
                  onBlur={(event) => {
                    const title = event.target.value.trim();
                    if (title !== '' && title !== selected.title) props.onUpdateNode(selected.id, { title });
                  }}
                  data-testid="graph-selected-title"
                />
                <textarea
                  defaultValue={selected.body}
                  key={`body-${selected.id}`}
                  rows={3}
                  onBlur={(event) => props.onUpdateNode(selected.id, { body: event.target.value })}
                  data-testid="graph-selected-body"
                />
                <div className="graph-row">
                  <select
                    value={selected.state}
                    onChange={(event) => props.onUpdateNode(selected.id, { state: event.target.value })}
                    data-testid="graph-selected-state"
                    aria-label="객체 상태"
                  >
                    {nodeStateOptions(selected.type).map((state) => (
                      <option key={state} value={state}>
                        {STATE_LABEL[state] ?? state}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => props.onDeleteNode(selected.id)}
                    data-testid="graph-selected-delete"
                  >
                    삭제
                  </button>
                </div>
              </div>
            )}

            <h4 className="graph-sublist-title">링크 {selectedLinks.length}</h4>
            <ul className="graph-link-list" data-testid="graph-selected-links">
              {selectedLinks.map((link) => {
                const other = link.src === selected.id ? link.dst : link.src;
                const outgoing = link.src === selected.id;
                return (
                  <li key={link.id}>
                    <span className={link.suspectSince === null ? '' : 'is-suspect'}>
                      {outgoing ? '→' : '←'} {GRAPH_LINK_LABEL[link.type]}{' '}
                      {nodes.find((node) => node.id === other)?.title ?? other}
                    </span>
                    <button
                      type="button"
                      className="btn btn--xs"
                      onClick={() => props.onDeleteLink(link.id)}
                      data-testid={`link-delete-${link.id}`}
                    >
                      끊기
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="graph-form graph-link-form">
              <select
                value={linkType}
                onChange={(event) => setLinkType(event.target.value as GraphLinkType)}
                data-testid="link-type"
                aria-label="링크 타입"
              >
                {GRAPH_LINK_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {GRAPH_LINK_LABEL[type]}
                  </option>
                ))}
              </select>
              <select
                value={linkTarget}
                onChange={(event) => setLinkTarget(event.target.value)}
                data-testid="link-target"
                aria-label="연결 대상"
              >
                <option value="">대상 선택</option>
                {nodes
                  .filter((node) => node.id !== selected.id)
                  .map((node) => (
                    <option key={node.id} value={node.id}>
                      {NODE_TYPE_LABEL[node.type]} · {node.title}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                className="btn btn--sm"
                disabled={busy || linkTarget === ''}
                onClick={() => {
                  if (linkTarget === '') return;
                  const targetType = typeOfNode(nodes, linkTarget);
                  // The form offers one direction; the person reads it as
                  // "this node —link→ that node" whichever way it is stored.
                  if (targetType === null) return;
                  props.onCreateLink(linkType, selected.id, linkTarget);
                  setLinkTarget('');
                }}
                data-testid="link-add"
              >
                연결
              </button>
            </div>
          </section>
        )}

        <section className="graph-panel graph-matrix" data-testid="rtm-matrix">
          <h3 className="graph-panel-title">RTM 요약 · 선택 화면</h3>
          <table>
            <thead>
              <tr>
                <th>링크</th>
                <th>개수</th>
              </tr>
            </thead>
            <tbody>
              {GRAPH_LINK_TYPES.map((type) => (
                <tr key={type}>
                  <td>{GRAPH_LINK_LABEL[type]}</td>
                  <td className="mono">{(props.screenReport??report).byType[type]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </aside>
    </main>
  );
}
