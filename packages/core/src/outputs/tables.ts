import { PIN_TYPE_LABEL, type Pin, type PinType, type Screen } from '@spec-studio/protocol';
import { countByType, missingPinNumbers, nextPinNumber, pinLabel, sortPinsByNumber } from '../pins';

/**
 * The design sheet a spec is handed off in: three tables, one per W1 pin
 * type, filled from the pins that already exist. This is a pure projection —
 * it reads the pins and writes nothing, so the generated document can never
 * disagree with the screen it came from.
 */
export interface SpecTableRow {
  pinId: string;
  pinType: PinType;
  number: number;
  label: string;
  title: string;
  body: string;
  /** `사전조건: …` pulled out of the body, or '' when the pin states none. */
  precondition: string;
}

export interface SpecTable {
  pinType: PinType;
  heading: string;
  note: string;
  rows: SpecTableRow[];
}

export interface SpecOverview {
  screenId: string;
  screenCode: string;
  screenTitle: string;
  tables: SpecTable[];
  /** Pins of types outside the W1 three (state · data · permission). */
  extras: SpecTableRow[];
  gaps: number[];
  pinSeq: number;
  nextNumber: number;
  totals: Record<PinType, number>;
  total: number;
}

/** The three tables W2 promises. Order here is the order they are printed. */
export const CANONICAL_TABLE_TYPES: readonly PinType[] = ['function', 'policy', 'exception'];

export const TABLE_HEADING: Record<PinType, string> = {
  function: '기능 표',
  policy: '정책 표',
  exception: '예외 표',
  state: '상태 표',
  data: '데이터 표',
  permission: '권한 표',
};

export const TABLE_NOTE: Record<PinType, string> = {
  function: '사용자가 이 화면에서 할 수 있는 일과 그 결과',
  policy: '무엇을 허용하고 무엇을 막는지 — 판단이 필요한 규칙',
  exception: '정상 경로가 아닐 때의 화면과 처리',
  state: '같은 화면의 다른 상태',
  data: '화면이 읽고 쓰는 값',
  permission: '누가 볼 수 있고 누가 할 수 없는지',
};

const PRECONDITION_LINE =
  /^\s*(?:사전\s*조건|전제\s*조건|전제|조건|상태|precondition)\s*[:：]\s*(.+?)\s*$/i;

/**
 * A pin body is free text, but a line that starts with `사전조건:` is a
 * promise the QA sheet needs as its own column. First match wins.
 */
export function extractPrecondition(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const match = PRECONDITION_LINE.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return '';
}

function toRow(screen: Screen, pin: Pin): SpecTableRow {
  return {
    pinId: pin.id,
    pinType: pin.type,
    number: pin.number,
    label: pinLabel(screen.code, pin.number),
    title: pin.title,
    body: pin.body,
    precondition: extractPrecondition(pin.body),
  };
}

export function buildSpecOverview(input: {
  screen: Screen;
  pins: readonly Pin[];
  pinSeq?: number;
}): SpecOverview {
  const ordered = sortPinsByNumber(input.pins);
  const byType = new Map<PinType, SpecTableRow[]>();
  for (const pin of ordered) {
    const rows = byType.get(pin.type) ?? [];
    rows.push(toRow(input.screen, pin));
    byType.set(pin.type, rows);
  }

  const tables: SpecTable[] = CANONICAL_TABLE_TYPES.map((pinType) => ({
    pinType,
    heading: TABLE_HEADING[pinType],
    note: TABLE_NOTE[pinType],
    rows: byType.get(pinType) ?? [],
  }));

  const extras: SpecTableRow[] = [];
  for (const [pinType, rows] of byType) {
    if (!CANONICAL_TABLE_TYPES.includes(pinType)) extras.push(...rows);
  }
  extras.sort((a, b) => a.number - b.number);

  const pinSeq = Math.max(input.pinSeq ?? 0, ordered.at(-1)?.number ?? 0);

  return {
    screenId: input.screen.id,
    screenCode: input.screen.code,
    screenTitle: input.screen.title,
    tables,
    extras,
    gaps: missingPinNumbers(ordered, pinSeq),
    pinSeq,
    nextNumber: nextPinNumber(pinSeq),
    totals: countByType(ordered),
    total: ordered.length,
  };
}

/** Type label used by the CSV and the HTML when widening beyond the W1 three. */
export function typeLabel(pinType: PinType): string {
  return PIN_TYPE_LABEL[pinType];
}
