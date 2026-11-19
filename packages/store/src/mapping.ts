import { createHash, randomBytes } from 'node:crypto';
import type { Pin, Project, Screen, ScreenRef } from '@spec-studio/protocol';

/**
 * Row ↔ object mapping. The schema stores one shape (`obj` with a JSON
 * `props`) and the domain uses another (typed screens and pins), so the
 * translation lives here, in one file, with the column names in one place.
 */

export interface ObjRow {
  id: string;
  project_id: string | null;
  kind: string;
  subtype: string | null;
  title: string;
  parent_id: string | null;
  props: string;
  state: string;
  rev: number;
  hash: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScreenProps {
  code: string;
  ref: ScreenRef;
  /** Registered Figma frame, or null. Reference data, never fetched. */
  figmaUrl?: string | null;
  viewport: { width: number; height: number } | null;
  pinSeq: number;
}

export interface PinProps {
  number: number;
  body: string;
  anchor: { x: number; y: number };
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

/** Short, stable content hash: the schema only needs it to be non-empty and to change with content. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newSuffix(length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += ALPHABET.charAt(byte % ALPHABET.length);
  return out;
}

export const newProjectId = (): string => `PRJ_${newSuffix()}`;
export const newScreenId = (): string => `S_${newSuffix()}`;
export const newPinId = (): string => `P_${newSuffix()}`;

export function screenToRow(screen: Screen, projectId: string): ObjRow {
  const props: ScreenProps = {
    code: screen.code,
    ref: screen.ref,
    figmaUrl: screen.figmaUrl ?? null,
    viewport: screen.viewport,
    pinSeq: 0,
  };
  return {
    id: screen.id,
    project_id: projectId,
    kind: 'screen',
    subtype: null,
    title: screen.title,
    parent_id: null,
    props: JSON.stringify(props),
    state: 'linked',
    rev: 1,
    hash: contentHash({
      title: screen.title,
      code: screen.code,
      ref: screen.ref,
      figmaUrl: screen.figmaUrl ?? null,
    }),
    deleted_at: null,
    created_at: screen.createdAt,
    updated_at: screen.updatedAt,
  };
}

export function screenFromRow(row: ObjRow): Screen {
  const props = parseJson<ScreenProps>(row.props);
  return {
    id: row.id,
    title: row.title,
    code: props.code,
    ref: props.ref,
    figmaUrl: props.figmaUrl ?? null,
    viewport: props.viewport ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function screenPinSeq(row: ObjRow): number {
  return parseJson<ScreenProps>(row.props).pinSeq ?? 0;
}

export function pinToRow(pin: Pin, projectId: string): ObjRow {
  const props: PinProps = { number: pin.number, body: pin.body, anchor: pin.anchor };
  return {
    id: pin.id,
    project_id: projectId,
    kind: 'pin',
    subtype: pin.type,
    title: pin.title,
    parent_id: pin.screenId,
    props: JSON.stringify(props),
    state: 'open',
    rev: 1,
    hash: contentHash({ title: pin.title, type: pin.type, body: pin.body, number: pin.number }),
    deleted_at: null,
    created_at: pin.createdAt,
    updated_at: pin.updatedAt,
  };
}

export function pinFromRow(row: ObjRow): Pin {
  const props = parseJson<PinProps>(row.props);
  return {
    id: row.id,
    screenId: row.parent_id ?? '',
    number: props.number,
    type: row.subtype as Pin['type'],
    title: row.title,
    body: props.body,
    anchor: props.anchor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function projectFromRows(input: {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  screen: ObjRow | null;
  pins: ObjRow[];
}): Project {
  const screen = input.screen === null ? null : screenFromRow(input.screen);
  const pins = input.pins.map(pinFromRow).sort((a, b) => a.number - b.number);
  return {
    version: 1,
    id: input.id,
    name: input.name,
    screen,
    pins,
    pinSeq: input.screen === null ? 0 : screenPinSeq(input.screen),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}
