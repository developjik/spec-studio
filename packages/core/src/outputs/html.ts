import type { Doc, Pin, Screen } from '@spec-studio/protocol';
import { staleBadges } from '../doc';
import { inlineImage, slug } from './base64';
import { buildSpecOverview, type SpecTable, type SpecTableRow } from './tables';
import { PIN_TYPE_COLOR } from './overlay';

/**
 * The handoff document. One file, no build step, no app: open it in a browser
 * from a USB stick and it looks the same. That promise is why the CSS is
 * inline, the image is a base64 data URL and nothing — not a font, not a
 * stylesheet — is fetched.
 */
export interface StaticHtmlInput {
  screen: Screen;
  pins: readonly Pin[];
  pinSeq?: number;
  /** The document beside the screen (W4). Absent leaves the sheet as it was. */
  doc?: Doc | null;
  /** Passed in: core never reads the clock. */
  generatedAt: string;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

function percent(value: number): string {
  return `${(Math.min(1, Math.max(0, value)) * 100).toFixed(2)}%`;
}

function renderPin(pin: Pin): string {
  const style = `left:${percent(pin.anchor.x)};top:${percent(pin.anchor.y)};--pin:${PIN_TYPE_COLOR[pin.type]}`;
  return `<div class="marker" style="${style}" title="#${pin.number} ${escapeHtml(pin.title)}"><span>#${pin.number}</span></div>`;
}

function renderTable(table: SpecTable): string {
  const columns = ['번호', '제목', '검증 내용', '사전조건'];
  const head = columns.map((column) => `<th scope="col">${column}</th>`).join('');

  if (table.rows.length === 0) {
    return `<section class="table-block">
  <h2>${escapeHtml(table.heading)}<span class="count">0</span></h2>
  <p class="note">${escapeHtml(table.note)}</p>
  <p class="empty">이 유형의 핀이 없습니다.</p>
</section>`;
  }

  const rows = table.rows
    .map(
      (row: SpecTableRow) => `<tr>
    <th scope="row"><span class="num" style="--pin:${PIN_TYPE_COLOR[row.pinType]}">#${row.number}</span></th>
    <td class="cell-title">${escapeHtml(row.title)}<span class="ref">${escapeHtml(row.label)}</span></td>
    <td class="cell-body">${row.body === '' ? '<span class="muted">—</span>' : escapeHtml(row.body)}</td>
    <td class="cell-pre">${row.precondition === '' ? '<span class="muted">기본 상태</span>' : escapeHtml(row.precondition)}</td>
  </tr>`,
    )
    .join('\n');

  return `<section class="table-block">
  <h2>${escapeHtml(table.heading)}<span class="count">${table.rows.length}</span></h2>
  <p class="note">${escapeHtml(table.note)}</p>
  <table>
    <thead><tr>${head}</tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</section>`;
}

/**
 * The document section (W4): paragraphs as written, each with the pins it
 * stands on. A block whose pin facts moved is marked here too, so a printed
 * copy does not quietly carry a sentence the screen no longer supports.
 */
function renderDoc(input: { doc: Doc; pins: readonly Pin[] }): string {
  const badges = staleBadges(input.doc, input.pins);
  const byId = new Map(input.pins.map((pin) => [pin.id, pin] as const));
  const blocks = input.doc.blocks
    .map((block) => {
      const stale = badges.filter((badge) => badge.blockId === block.id).length > 0;
      const pins = block.pinRefs.map((ref) => {
        const pin = byId.get(ref.pinId);
        const label = pin === undefined ? '#? 삭제된 핀' : `#${pin.number} ${pin.title}`;
        return `<span class="doc-ref">${escapeHtml(label)}</span>`;
      });
      const body =
        block.type === 'heading'
          ? `<h3>${escapeHtml(block.text)}</h3>`
          : block.type === 'list'
            ? `<p class="doc-list">${escapeHtml(block.text).replace(/\r?\n/g, '<br>')}</p>`
            : `<p>${escapeHtml(block.text).replace(/\r?\n/g, '<br>')}</p>`;
      return `<li class="doc-block${stale ? ' is-stale' : ''}">${body}${
        pins.length === 0 ? '' : `<p class="doc-pins">${pins.join('')}</p>`
      }${stale ? '<p class="doc-stale">핀이 바뀜 · 확인 필요</p>' : ''}</li>`;
    })
    .join('\n    ');

  return `<section class="doc">
  <h2>${escapeHtml(input.doc.title)}<span class="count">문단 ${input.doc.blocks.length}</span></h2>
  ${input.doc.blocks.length === 0 ? '<p class="empty">아직 문단이 없습니다.</p>' : `<ol class="doc-blocks">\n    ${blocks}\n  </ol>`}
</section>`;
}

const STYLE = `
:root{color-scheme:light;--ink:#0f1216;--ink-2:#3f4650;--ink-3:#6b7280;--line:#e5e8ed;--line-2:#d3d9e2;--bg:#fff;--bg-sub:#f7f8fa;--mono:ui-monospace,SFMono-Regular,'JetBrains Mono',Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans KR','Apple SD Gothic Neo','Malgun Gothic',sans-serif}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg-sub);color:var(--ink);font-family:var(--sans);font-size:13.5px;line-height:1.6;letter-spacing:-.006em;-webkit-font-smoothing:antialiased}
.sheet{max-width:1180px;margin:0 auto;background:var(--bg);padding:44px 48px 56px;border-left:1px solid var(--line);border-right:1px solid var(--line);min-height:100vh}
.head{display:flex;flex-direction:column;gap:10px;padding-bottom:22px;border-bottom:2px solid var(--ink)}
.eyebrow{margin:0;font-family:var(--mono);font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-3)}
h1{margin:0;font-size:30px;line-height:1.2;letter-spacing:-.02em;font-weight:700}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px 22px;margin:6px 0 0}
.meta div{display:flex;flex-direction:column;gap:2px}
.meta dt{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);font-family:var(--mono)}
.meta dd{margin:0;font-size:12.5px;color:var(--ink)}
.mono{font-family:var(--mono);font-size:12px}
.board{margin:26px 0 8px}
.frame{position:relative;container-type:inline-size;border:1px solid var(--line-2);background:#fff;line-height:0}
.frame img{display:block;width:100%;height:auto}
.frame-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:var(--bg-sub);border:1px dashed var(--line-2);color:var(--ink-3);font-size:11.5px;line-height:1.5;text-align:center;padding:24px}
.marker{position:absolute;transform:translate(-50%,-50%);z-index:2}
.marker span{flex:none;display:grid;place-items:center;width:28px;height:28px;width:clamp(20px,2.6cqw,34px);height:clamp(20px,2.6cqw,34px);border-radius:50%;background:var(--pin);color:#fff;border:2px solid #fff;font-family:var(--mono);font-weight:600;font-size:11px;font-size:clamp(8px,1cqw,13px);letter-spacing:-.02em;box-shadow:0 1px 3px rgba(15,18,22,.32);line-height:1}
.caption{margin:8px 0 0;font-size:11px;color:var(--ink-3);font-family:var(--mono)}
.legend{margin:18px 0 0;padding:0;list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px 18px;border-top:1px solid var(--line);padding-top:14px}
.legend li{display:flex;align-items:baseline;gap:8px;font-size:12px;color:var(--ink-2);min-width:0}
.legend b{flex:none;font-family:var(--mono);font-size:11px;font-weight:600;color:#fff;background:var(--pin);padding:1px 6px;border-radius:3px}
.legend span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tables{margin-top:34px;display:flex;flex-direction:column;gap:30px}
.table-block h2{display:flex;align-items:baseline;gap:8px;margin:0;font-size:15.5px;letter-spacing:-.01em;padding-bottom:7px;border-bottom:1px solid var(--ink)}
.count{font-family:var(--mono);font-size:11px;font-weight:500;color:var(--ink-3)}
.note{margin:6px 0 10px;font-size:11.5px;color:var(--ink-3)}
table{width:100%;border-collapse:collapse;font-size:12.5px}
thead th{text-align:left;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);font-family:var(--mono);font-weight:500;padding:0 10px 6px 0;border-bottom:1px solid var(--line-2)}
tbody th,tbody td{vertical-align:top;padding:9px 10px 9px 0;border-bottom:1px solid var(--line)}
tbody th{width:52px;text-align:left;font-weight:400}
.num{display:inline-grid;place-items:center;min-width:22px;height:22px;padding:0 5px;border-radius:3px;background:var(--pin);color:#fff;font-family:var(--mono);font-size:11px;font-weight:600}
.cell-title{width:26%;font-weight:600}
.ref{display:block;font-family:var(--mono);font-size:10px;font-weight:400;color:var(--ink-3);margin-top:2px}
.cell-body{white-space:pre-wrap;color:var(--ink-2)}
.cell-pre{width:18%;color:var(--ink-2)}
.muted{color:var(--ink-3)}
.empty{margin:0;padding:12px 0;font-size:12px;color:var(--ink-3);border-bottom:1px solid var(--line)}
.gaps{margin-top:34px;padding:14px 16px;border:1px solid var(--line-2);background:var(--bg-sub)}
.gaps h2{margin:0 0 4px;font-size:12.5px}
.gaps p{margin:0;font-size:12px;color:var(--ink-2)}
.gaps b{font-family:var(--mono);font-weight:600;color:var(--ink)}
.doc{margin-top:34px}
.doc h2{display:flex;align-items:baseline;gap:8px;margin:0 0 10px;font-size:15.5px;padding-bottom:7px;border-bottom:1px solid var(--ink)}
.doc-blocks{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:12px}
.doc-block{padding:2px 0 2px 12px;border-left:2px solid var(--line-2)}
.doc-block.is-stale{border-left-color:var(--warn,#b4690e);background:#fdf9f2}
.doc-block h3{margin:0;font-size:13.5px}
.doc-block p{margin:0;white-space:normal;color:var(--ink-2)}
.doc-pins{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px !important}
.doc-ref{font-family:var(--mono);font-size:10.5px;color:var(--accent,#2453c9);background:#eef2fc;border:1px solid #c8d5f5;border-radius:999px;padding:1px 7px}
.doc-stale{margin-top:4px !important;font-size:10.5px;color:#b4690e;font-family:var(--mono)}
.foot{margin-top:34px;padding-top:14px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:20px;font-size:10.5px;color:var(--ink-3);font-family:var(--mono)}
@media (max-width:720px){.sheet{padding:26px 18px 40px}h1{font-size:23px}.cell-pre{display:none}thead th:nth-child(4){display:none}}
@media print{body{background:#fff}.sheet{border:0;padding:0;max-width:none}.table-block{break-inside:avoid}@page{margin:14mm}}
`;

export function renderStaticHtml(input: StaticHtmlInput): string {
  const { screen, generatedAt } = input;
  const overview = buildSpecOverview({ screen, pins: input.pins, ...(input.pinSeq === undefined ? {} : { pinSeq: input.pinSeq }) });
  const image = screen.ref.kind === 'image' ? inlineImage(screen.ref.value) : null;
  const frameRatio =
    screen.viewport === null
      ? '16 / 10'
      : `${screen.viewport.width} / ${screen.viewport.height}`;

  const filters: string[] = [];
  if (screen.ref.kind === 'figma_frame') filters.push('Figma 프레임 참조');
  if (screen.ref.kind === 'route') filters.push('라우트 참조');

  const legend = overview.tables
    .flatMap((table) => table.rows)
    .concat(overview.extras)
    .sort((a, b) => a.number - b.number)
    .map(
      (row) =>
        `<li><b style="--pin:${PIN_TYPE_COLOR[row.pinType]}">#${row.number}</b><span>${escapeHtml(row.title)}</span></li>`,
    )
    .join('\n      ');

  const gapLine =
    overview.gaps.length === 0
      ? '끊긴 번호 없음'
      : `결번 <b>${overview.gaps.map((number) => `#${number}`).join(', ')}</b>`;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(screen.title)} — ${escapeHtml(screen.code)} 화면설계서</title>
<meta name="description" content="${escapeHtml(screen.title)} ${escapeHtml(screen.code)} 화면설계서 · 핀 ${overview.total}개 · spec-studio">
<meta name="generator" content="spec-studio · static handoff">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<style>${STYLE}</style>
</head>
<body>
<main class="sheet">
  <header class="head">
    <p class="eyebrow">화면설계서 · Screen spec</p>
    <h1>${escapeHtml(screen.title)}</h1>
    <dl class="meta">
      <div><dt>화면 코드</dt><dd class="mono">${escapeHtml(screen.code)}</dd></div>
      <div><dt>화면 ID</dt><dd class="mono">${escapeHtml(screen.id)}</dd></div>
      <div><dt>핀</dt><dd>${overview.total}개 · 다음 #${overview.nextNumber}</dd></div>
      <div><dt>화면 크기</dt><dd class="mono">${screen.viewport === null ? '미지정' : `${screen.viewport.width}×${screen.viewport.height}`}</dd></div>
      <div><dt>소스</dt><dd>${escapeHtml(screen.ref.kind === 'image' ? (screen.ref.label ?? '이미지') : screen.ref.kind === 'figma_frame' ? 'Figma 프레임' : '라우트')}</dd></div>
      <div><dt>생성</dt><dd class="mono">${escapeHtml(generatedAt)}</dd></div>
    </dl>
  </header>

  <section class="board">
    <div class="frame" style="aspect-ratio:${frameRatio}">
      ${image === null ? `<div class="frame-empty"><span class="mono">${escapeHtml(screen.ref.value)}</span><span>이미지 없이 등록된 화면 — 좌표는 화면 기준입니다.</span></div>` : `<img src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(screen.title)} 화면 이미지">`}
      ${input.pins.map(renderPin).join('\n      ')}
    </div>
    ${filters.length === 0 ? '' : `<p class="caption">${escapeHtml(filters.join(' · '))} — 좌표는 화면 기준이며, 이 문서에는 프레임 이미지가 포함되지 않습니다.</p>`}
    <ul class="legend">
      ${legend === '' ? '<li><span>핀이 없습니다.</span></li>' : legend}
    </ul>
  </section>

  <div class="tables">
${overview.tables.map(renderTable).join('\n')}
  </div>

  ${input.doc === undefined || input.doc === null ? '' : renderDoc({ doc: input.doc, pins: input.pins })}

  <section class="gaps">
    <h2>번호 규칙</h2>
    <p>${gapLine} · 삭제된 번호는 다시 쓰지 않으며, 다음 핀은 <b>#${overview.nextNumber}</b>입니다.</p>
  </section>

  <footer class="foot">
    <span>spec-studio · 정적 핸드오프 · 외부 요청 0건</span>
    <span>${escapeHtml(screen.code)} · ${overview.total} pins</span>
  </footer>
</main>
</body>
</html>
`;
}

/** `spec-studio-scr-110.html` */
export function staticHtmlFileName(screen: Screen): string {
  return `spec-studio-${slug(screen.code)}.html`;
}
