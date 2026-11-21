import type { Pin, Screen } from '@spec-studio/protocol';
import { sortPinsByNumber } from '../pins';
import { buildSpecOverview, typeLabel } from './tables';

/**
 * The QA sheet is the output a tester actually types into. Excel is the
 * destination, so: UTF-8 with a BOM (otherwise `기능` arrives as mojibake),
 * CRLF line endings, and every cell quoted only when it has to be.
 */
export const QA_CSV_COLUMNS = [
  '케이스ID',
  '화면ID',
  '화면명',
  '핀번호',
  '유형',
  '제목',
  '검증내용(설명)',
  '사전조건/상태',
  '결과(미실행)',
] as const;

export const QA_CSV_RESULT_PENDING = '미실행';
export const QA_CSV_DEFAULT_PRECONDITION = '기본 상태';

const BOM = '\uFEFF';
const EOL = '\r\n';

/**
 * Derived from the pin number, never from the row index: deleting #2 must not
 * renumber the case built from #3. Same promise as the pin itself.
 */
export function qaCaseId(number: number): string {
  return `TC-${String(number).padStart(3, '0')}`;
}

/**
 * Excel, Numbers and Sheets all treat a cell that starts with `=`, `+`, `-` or
 * `@` as a formula; `\t` and `\r` are stripped first and get the same job done.
 * A pin body is prose a person wrote or a model drafted, and this CSV is meant
 * to be opened in a spreadsheet, so the leading character is neutralised with
 * an apostrophe — the cell reads exactly as written, and nothing executes.
 */
const CSV_FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvCell(value: string): string {
  const neutralized = CSV_FORMULA_LEAD.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(neutralized)) return `"${neutralized.replace(/"/g, '""')}"`;
  return neutralized;
}

export interface QaCsvRow {
  caseId: string;
  screenId: string;
  screenName: string;
  number: number;
  typeLabel: string;
  title: string;
  body: string;
  precondition: string;
  result: string;
}

export function buildQaRows(input: { screen: Screen; pins: readonly Pin[] }): QaCsvRow[] {
  const overview = buildSpecOverview(input);
  const rows = [...overview.tables.flatMap((table) => table.rows), ...overview.extras].sort(
    (a, b) => a.number - b.number,
  );

  return rows.map((row) => ({
    caseId: qaCaseId(row.number),
    screenId: `${input.screen.code} (${input.screen.id})`,
    screenName: input.screen.title,
    number: row.number,
    typeLabel: typeLabel(row.pinType),
    title: row.title,
    body: row.body,
    precondition: row.precondition === '' ? QA_CSV_DEFAULT_PRECONDITION : row.precondition,
    result: QA_CSV_RESULT_PENDING,
  }));
}

export function buildQaCsv(input: { screen: Screen; pins: readonly Pin[] }): string {
  const ordered = sortPinsByNumber(input.pins);
  const rows = buildQaRows({ screen: input.screen, pins: ordered });

  const lines = [QA_CSV_COLUMNS.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(
      [
        csvCell(row.caseId),
        csvCell(row.screenId),
        csvCell(row.screenName),
        csvCell(String(row.number)),
        csvCell(row.typeLabel),
        csvCell(row.title),
        csvCell(row.body),
        csvCell(row.precondition),
        csvCell(row.result),
      ].join(','),
    );
  }

  return `${BOM}${lines.join(EOL)}${EOL}`;
}
