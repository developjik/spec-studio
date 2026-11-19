import {
  PIN_TYPE_LABEL,
  type Doc,
  type Pin,
  type Screen,
} from '@spec-studio/protocol';
import { staleBadges } from '@spec-studio/core';
import { buildSpecOverview, extractPrecondition, type SpecTable } from '@spec-studio/core';

/**
 * The Confluence page body, in Storage Format (XHTML).
 *
 * The page is a copy. It says so in its first line, and every number it shows
 * is the one the local pin already carries — nothing here is renumbered for the
 * remote tool. Tables are plain XHTML; attachments are `ac:link`s so Confluence
 * renders them as the uploaded files rather than as text.
 */

export type PublishAttachmentKind = 'overlay-png' | 'spec-html' | 'qa-csv';

export interface PublishAttachmentInfo {
  kind: PublishAttachmentKind;
  fileName: string;
  label: string;
  detail: string;
  contentType: string;
  bytes: number;
}

export interface PublishBodyInput {
  projectName: string;
  screen: Screen;
  pins: readonly Pin[];
  pinSeq: number;
  figmaUrl: string | null;
  /** W4: the document beside the screen, when the project has one. */
  doc?: Doc | null;
  generatedAt: string;
  specHash: string;
  attachments: readonly PublishAttachmentInfo[];
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

function multiline(value: string): string {
  return escapeXml(value).replace(/\r?\n/g, '<br />');
}

export function publishTitle(input: { projectName: string; screen: Screen | null }): string {
  const base = input.screen === null ? input.projectName : input.screen.title;
  return `[spec-studio] ${base}`;
}

function attachmentLink(attachment: PublishAttachmentInfo): string {
  return (
    '<ac:link><ri:attachment ri:filename="' +
    escapeXml(attachment.fileName) +
    '" /><ac:link-body>' +
    escapeXml(attachment.fileName) +
    '</ac:link-body></ac:link>'
  );
}

function renderTable(table: SpecTable): string {
  const head =
    '<tr><th>번호</th><th>제목</th><th>설명</th><th>사전조건</th></tr>';
  const rows =
    table.rows.length === 0
      ? '<tr><td colspan="4">이 유형의 핀이 없습니다.</td></tr>'
      : table.rows
          .map((row) => {
            const precondition = row.precondition === '' ? '—' : escapeXml(row.precondition);
            const body = row.body === '' ? '—' : multiline(row.body);
            return (
              '<tr><td><strong>#' +
              row.number +
              '</strong></td><td>' +
              escapeXml(row.title) +
              '</td><td>' +
              body +
              '</td><td>' +
              precondition +
              '</td></tr>'
            );
          })
          .join('');

  return (
    '<h2>' +
    escapeXml(table.heading) +
    ' <span style="color:#6b7280;font-weight:400">(' +
    table.rows.length +
    ')</span></h2>' +
    '<p style="color:#6b7280">' +
    escapeXml(table.note) +
    '</p>' +
    '<table><tbody>' +
    head +
    rows +
    '</tbody></table>'
  );
}

/**
 * The document as a Confluence section: each block keeps its wording, and the
 * pins it stands on are named the way the screen numbers them. A block whose
 * pin facts moved is marked, so a reader knows the sentence needs a look.
 */
function renderDocSection(doc: Doc, pins: readonly Pin[]): string {
  if (doc.blocks.length === 0) return '';
  const badges = staleBadges(doc, pins);
  const byId = new Map(pins.map((pin) => [pin.id, pin] as const));
  const blocks = doc.blocks
    .map((block) => {
      const stale = badges.some((badge) => badge.blockId === block.id);
      const refs = block.pinRefs
        .map((ref) => {
          const pin = byId.get(ref.pinId);
          return pin === undefined ? '#? 삭제된 핀' : `#${pin.number} ${pin.title}`;
        })
        .join(' · ');
      const meta = refs === '' ? '' : `<br /><small>${escapeXml(refs)}</small>`;
      const mark = stale ? ' <strong>(핀 변경 · 확인 필요)</strong>' : '';
      return block.type === 'heading'
        ? `<h3>${escapeXml(block.text)}${mark}</h3>`
        : `<p>${multiline(block.text)}${mark}${meta}</p>`;
    })
    .join('\n');
  return `<h2>${escapeXml(doc.title)}</h2>\n${blocks}`;
}

export function renderPublishBody(input: PublishBodyInput): string {
  const overview = buildSpecOverview({
    screen: input.screen,
    pins: input.pins,
    pinSeq: input.pinSeq,
  });
  const counts = (['function', 'policy', 'exception'] as const)
    .map((type) => `${PIN_TYPE_LABEL[type]} ${overview.totals[type]}`)
    .join(' · ');
  const gapText =
    overview.gaps.length === 0
      ? '없음'
      : overview.gaps.map((number) => `#${number}`).join(', ') +
        ' — 삭제된 번호는 다시 쓰지 않습니다.';
  const figma =
    input.figmaUrl === null
      ? ''
      : '<h2>Figma 프레임</h2><p><a href="' +
        escapeXml(input.figmaUrl) +
        '">' +
        escapeXml(input.figmaUrl) +
        '</a></p>';
  const overlay = input.attachments.find((attachment) => attachment.kind === 'overlay-png');

  const summary =
    '<table><tbody>' +
    `<tr><th>프로젝트</th><td>${escapeXml(input.projectName)}</td></tr>` +
    `<tr><th>화면</th><td>${escapeXml(input.screen.title)} <code>${escapeXml(
      input.screen.code,
    )}</code></td></tr>` +
    `<tr><th>핀</th><td>${overview.total}개 (${counts})</td></tr>` +
    `<tr><th>결번</th><td>${escapeXml(gapText)}</td></tr>` +
    `<tr><th>발행 시각</th><td>${escapeXml(input.generatedAt)}</td></tr>` +
    `<tr><th>스펙 해시</th><td><code>${escapeXml(input.specHash)}</code></td></tr>` +
    '</tbody></table>';

  const attachmentList =
    input.attachments.length === 0
      ? '<p>첨부 파일이 없습니다.</p>'
      : '<ul>' +
        input.attachments
          .map(
            (attachment) =>
              `<li>${attachmentLink(attachment)} — ${escapeXml(attachment.label)} · ${escapeXml(
                attachment.detail,
              )}</li>`,
          )
          .join('') +
        '</ul>';

  return [
    '<p><strong>로컬 정본에서 단방향으로 복사한 화면설계서입니다.</strong> ' +
      '이 페이지를 고쳐도 spec-studio의 원본은 바뀌지 않습니다.</p>',
    summary,
    figma,
    '<h2>화면</h2>',
    overlay === undefined
      ? '<p><ac:link><ri:attachment ri:filename="' +
        escapeXml(input.attachments[0]?.fileName ?? 'overlay.png') +
        '" /><ac:link-body>오버레이 이미지 열기</ac:link-body></ac:link></p>'
      : `<p><ac:image ac:alt="번호 핀이 합성된 화면"><ri:attachment ri:filename="${escapeXml(
          overlay.fileName,
        )}" /></ac:image></p>`,
    renderTable(overview.tables[0] as SpecTable),
    renderTable(overview.tables[1] as SpecTable),
    renderTable(overview.tables[2] as SpecTable),
    input.doc === undefined || input.doc === null ? '' : renderDocSection(input.doc, input.pins),
    '<h2>결번</h2>',
    `<p>${escapeXml(gapText)}</p>`,
    '<h2>첨부 파일</h2>',
    attachmentList,
    `<p style="color:#6b7280">생성: spec-studio · 화면 ${escapeXml(
      input.screen.code,
    )} · 스펙 해시 ${escapeXml(input.specHash)}</p>`,
  ].join('\n');
}

/** The QA precondition column comes from the same rule the CSV uses. */
export function preconditionOf(pin: Pin): string {
  return extractPrecondition(pin.body);
}
