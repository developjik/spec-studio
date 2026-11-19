import type { GraphProposal } from '@spec-studio/protocol';
import { pinNumberOf, type GoldenCase } from './cases.js';

/**
 * Four numbers per case, and one guard rail.
 *
 * schema   the proposal still parses as a GraphProposal (and has a node)
 * types    of the node types a good answer must carry, how many are there
 * links    of the link types it must carry (governs, derived_from, …), how many
 * pins     of the pin numbers the sentence stands on, how many the drafts cite
 * grounded share of drafted nodes that cite an existing pin at all —
 *          a hallucination shows up here before it shows up in pins, because an
 *          invented pin number simply resolves to nothing.
 */
export interface CaseScore {
  id: string;
  category: string;
  schema: boolean;
  types: number;
  links: number;
  pins: number;
  grounded: number;
  nodes: number;
  linksCreated: number;
  note: string;
}

function recall(expected: readonly string[], produced: ReadonlySet<string>): number {
  if (expected.length === 0) return 1;
  return expected.filter((value) => produced.has(value)).length / expected.length;
}

export function scoreProposal(
  testCase: GoldenCase,
  category: string,
  projectPins: Parameters<typeof pinNumberOf>[0],
  proposal: GraphProposal | null,
  schemaValid: boolean,
): CaseScore {
  const nodes = proposal?.nodes ?? [];
  const links = proposal?.links ?? [];
  const nodeTypes = new Set<string>(nodes.map((node) => node.type));
  const linkTypes = new Set<string>(links.map((link) => link.type));
  const citedPins = new Set<number>(
    nodes
      .map((node) => pinNumberOf(projectPins, node.pinId))
      .filter((value): value is number => value !== null),
  );
  const grounded = nodes.length === 0 ? 0 : nodes.filter((node) => node.pinId !== null).length / nodes.length;

  return {
    id: testCase.id,
    category,
    schema: schemaValid && nodes.length > 0,
    types: recall(testCase.expect.types, nodeTypes),
    links: recall(testCase.expect.links, linkTypes),
    pins: recall(
      testCase.expect.pins.map((number) => String(number)),
      new Set([...citedPins].map((number) => String(number))),
    ),
    grounded,
    nodes: nodes.length,
    linksCreated: links.length,
    note: testCase.note,
  };
}

export interface Totals {
  cases: number;
  schema: number;
  types: number;
  links: number;
  pins: number;
  grounded: number;
}

export function totalsOf(scores: readonly CaseScore[]): Totals {
  const mean = (pick: (score: CaseScore) => number) =>
    scores.length === 0 ? 0 : scores.reduce((sum, score) => sum + pick(score), 0) / scores.length;
  return {
    cases: scores.length,
    schema: mean((score) => (score.schema ? 1 : 0)),
    types: mean((score) => score.types),
    links: mean((score) => score.links),
    pins: mean((score) => score.pins),
    grounded: mean((score) => score.grounded),
  };
}

/** The bar a proposal engine has to clear before its card is trusted. */
export const THRESHOLDS: Totals = {
  cases: 30,
  schema: 1,
  types: 0.85,
  links: 0.85,
  pins: 0.9,
  grounded: 0.9,
};

export function failuresOf(totals: Totals): string[] {
  const failures: string[] = [];
  if (totals.cases < THRESHOLDS.cases) {
    failures.push(`골든셋이 ${totals.cases}건입니다 (${THRESHOLDS.cases}건 필요)`);
  }
  if (totals.schema < THRESHOLDS.schema) failures.push(`스키마 유효성 ${(totals.schema * 100).toFixed(1)}%`);
  if (totals.types < THRESHOLDS.types) failures.push(`타입 포함률 ${(totals.types * 100).toFixed(1)}%`);
  if (totals.links < THRESHOLDS.links) failures.push(`링크 적중률 ${(totals.links * 100).toFixed(1)}%`);
  if (totals.pins < THRESHOLDS.pins) failures.push(`핀 근거 참조율 ${(totals.pins * 100).toFixed(1)}%`);
  if (totals.grounded < THRESHOLDS.grounded) failures.push(`근거 있는 초안 비율 ${(totals.grounded * 100).toFixed(1)}%`);
  return failures;
}
