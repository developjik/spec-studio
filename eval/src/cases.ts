import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AiDocDraftSchema,
  AiGraphDraftSchema,
  PinTypeSchema,
  type EditableNodeType,
  type Pin,
  type Project,
} from '@spec-studio/protocol';
import { createProject, execute, type IdKind } from '@spec-studio/core';

/**
 * The golden set.
 *
 * Thirty Korean screen-spec sentences, in the three families the roadmap asks
 * for — policy lines, tables/contracts, exceptions — each with what a good
 * proposal must contain: the node types, the link types, and the pin numbers
 * the sentences stand on. The set is data, not code: changing what "good"
 * means is editing JSON, and the same file grades the rule extractor and a
 * live model.
 */

export interface GoldenPin {
  number: number;
  type: string;
  title: string;
  body: string;
}

export interface GoldenCase {
  id: string;
  note: string;
  screen: { title: string; code: string };
  pins: GoldenPin[];
  expect: { types: EditableNodeType[]; links: string[]; pins: number[] };
}

export interface LoadedCase extends GoldenCase {
  category: string;
}

const AT = '2026-11-19T09:00:00.000Z';

export function loadGoldenCases(dir: string): LoadedCase[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json') && name !== 'brief.json')
    .sort();
  const cases: LoadedCase[] = [];
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`${file} is not an array of cases`);
    for (const entry of parsed) {
      const candidate = entry as GoldenCase;
      if (
        typeof candidate.id !== 'string' ||
        !Array.isArray(candidate.pins) ||
        candidate.expect === undefined
      ) {
        throw new Error(`${file} has a case without id/pins/expect`);
      }
      for (const pin of candidate.pins) PinTypeSchema.parse(pin.type);
      cases.push({ ...candidate, category: file.replace(/\.json$/, '') });
    }
  }
  return cases;
}

/** Deterministic ids: the same case always builds the same project. */
function idFactory(): (kind: IdKind, nodeType?: EditableNodeType) => string {
  const counters = new Map<string, number>();
  return (kind, nodeType) => {
    const key = `${kind}:${nodeType ?? ''}`;
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    const suffix = `${String(next).padStart(6, '0')}eval`;
    switch (kind) {
      case 'project':
        return `PRJ_${suffix}`;
      case 'screen':
        return `S_${suffix}`;
      case 'pin':
        return `P_${suffix}`;
      case 'doc':
        return `D_${suffix}`;
      case 'block':
        return `B_${suffix}`;
      case 'proposal':
        return `PR_${suffix}`;
      case 'node':
        return `${nodeType === 'contract' ? 'C' : nodeType === 'qa' ? 'V' : 'N'}_${suffix}`;
      case 'link':
        return `L_${suffix}`;
      case 'graphProposal':
        return `GP_${suffix}`;
      case 'idea':
        return `I_${suffix}`;
      case 'evidence':
        return `E_${suffix}`;
    }
  };
}

/** Builds the project a case describes, through the same commands the app uses. */
export function projectFor(testCase: GoldenCase): Project {
  const nextId = idFactory();
  let project = createProject({ id: nextId('project'), name: testCase.screen.title, at: AT });
  project = execute(
    project,
    {
      type: 'screen.attach',
      screen: {
        id: `S_${testCase.id.replace(/[^A-Za-z0-9]/g, '').toLowerCase().padEnd(8, '0').slice(0, 20)}`,
        title: testCase.screen.title,
        code: testCase.screen.code,
        ref: { kind: 'image', value: 'data:image/svg+xml;base64,PHN2Zy8+' },
        viewport: { width: 1280, height: 900 },
        createdAt: AT,
        updatedAt: AT,
      },
    },
    { at: AT, nextId },
  ).project;

  for (const pin of [...testCase.pins].sort((a, b) => a.number - b.number)) {
    project = execute(
      project,
      {
        type: 'pin.create',
        screenId: project.screen?.id ?? '',
        pinType: PinTypeSchema.parse(pin.type),
        title: pin.title,
        body: pin.body,
        anchor: { x: 0.2 + (pin.number % 3) * 0.2, y: 0.3 + (pin.number % 4) * 0.1 },
      },
      { at: AT, nextId },
    ).project;
  }
  return project;
}

/** The same shape the draft parser takes, so both paths are graded equally. */
export const draftSchemas = { graph: AiGraphDraftSchema, doc: AiDocDraftSchema };

export function pinNumberOf(project: Project, pinId: string | null): number | null {
  if (pinId === null) return null;
  const pin: Pin | undefined = project.pins.find((candidate) => candidate.id === pinId);
  return pin?.number ?? null;
}
