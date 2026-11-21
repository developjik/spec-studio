import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiBriefDraft, EvidenceType, Project } from '@spec-studio/protocol';
import { buildFallbackBrief } from '@spec-studio/ai';
import { createProject, execute, type IdKind } from '@spec-studio/core';

/**
 * The brief set (E1 §7-B-3): ten cases through the same fallback the daemon
 * ships, so the number the '로컬 규칙 폴백' badge stands behind is a gate, not
 * a claim. Two numbers matter — every citation names a provided evidence id
 * (hallucinated references are 0), and every claim is either grounded or
 * marked 근거 없음, in the counts the case expects.
 */

const AT = '2026-11-19T09:00:00.000Z';

export interface BriefEvidenceSpec {
  id?: string;
  title: string;
  url: string;
  excerpt: string;
  type: EvidenceType;
}

export interface BriefCase {
  id: string;
  group: 'grounded' | 'unsupported' | 'mixed';
  note: string;
  idea: { title?: string; text: string; url?: string };
  evidence: BriefEvidenceSpec[];
  expect: { grounded: number; ungrounded: number };
}

export function loadBriefCases(dir: string): BriefCase[] {
  const parsed = JSON.parse(readFileSync(join(dir, 'brief.json'), 'utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error('brief.json is not an array of cases');
  return parsed as BriefCase[];
}

const slugOf = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]/g, '');

function defaultEvidenceId(caseId: string, index: number): string {
  return `E_${slugOf(caseId)}ev${String(index + 1).padStart(2, '0')}`;
}

/** Deterministic ids: the same case always builds the same board. */
export function evidenceIdsOf(testCase: BriefCase): string[] {
  return testCase.evidence.map((row, index) => row.id ?? defaultEvidenceId(testCase.id, index));
}

/**
 * Seeds the board through the same commands the app sends — `idea.capture`,
 * `evidence.capture` — so the ids the drafts may cite are real project rows.
 */
export function briefProject(testCase: BriefCase): { project: Project; ideaId: string } {
  const ideaId = `I_${slugOf(testCase.id)}idea`;
  const evidenceIds = evidenceIdsOf(testCase);
  let evidenceSeq = 0;
  const nextId = (kind: IdKind): string => {
    if (kind === 'idea') return ideaId;
    if (kind === 'evidence') {
      const id = evidenceIds[evidenceSeq];
      evidenceSeq += 1;
      if (id === undefined) throw new Error(`${testCase.id}: more evidence captures than rows`);
      return id;
    }
    throw new Error(`brief cases never allocate '${kind}' ids`);
  };

  let project = createProject({
    id: `PRJ_${slugOf(testCase.id).padEnd(10, '0').slice(0, 16)}`,
    name: testCase.idea.title ?? testCase.id,
    at: AT,
  });
  project = execute(
    project,
    {
      type: 'idea.capture',
      text: testCase.idea.text,
      ...(testCase.idea.url === undefined ? {} : { url: testCase.idea.url }),
    },
    { at: AT, nextId },
  ).project;
  testCase.evidence.forEach((row, index) => {
    project = execute(
      project,
      {
        type: 'evidence.capture',
        url: row.url,
        title: row.title,
        excerpt: row.excerpt,
        evidenceType: row.type,
      },
      { at: AT, nextId: () => evidenceIds[index] as string },
    ).project;
  });
  return { project, ideaId };
}

export function fallbackBrief(testCase: BriefCase): AiBriefDraft {
  const { project, ideaId } = briefProject(testCase);
  return buildFallbackBrief(project, { ideaId });
}

// ── scoring ─────────────────────────────────────────────────────────────

export interface BriefCaseScore {
  id: string;
  group: string;
  claims: number;
  grounded: number;
  ungrounded: number;
  /** every claim's refs are all provided ids (precision, per claim) */
  citesProvided: number;
  /** claims whose marker tells the truth: ungrounded ⇔ no refs */
  honestMarkers: number;
  /** the case produced the grounded/ungrounded counts it expects */
  countsOk: boolean;
  schemaValid: boolean;
  note: string;
}

export function scoreBriefCase(
  testCase: BriefCase,
  providedIds: readonly string[],
  draft: AiBriefDraft | null,
): BriefCaseScore {
  const provided = new Set(providedIds);
  const claims = draft?.claims ?? [];
  const grounded = claims.filter((claim) => claim.evidenceRefs.length > 0).length;
  const citesProvided = claims.filter((claim) =>
    claim.evidenceRefs.every((ref) => provided.has(ref)),
  ).length;
  const honestMarkers = claims.filter(
    (claim) => claim.ungrounded === (claim.evidenceRefs.length === 0),
  ).length;
  return {
    id: testCase.id,
    group: testCase.group,
    claims: claims.length,
    grounded,
    ungrounded: claims.length - grounded,
    citesProvided,
    honestMarkers,
    countsOk:
      grounded === testCase.expect.grounded &&
      claims.length - grounded === testCase.expect.ungrounded,
    schemaValid: draft !== null,
    note: testCase.note,
  };
}

export interface BriefTotals {
  cases: number;
  claims: number;
  /** 인용 정확성: refs ⊆ provided ids, over every claim of every case. */
  precision: number;
  /** 근거 없음 마커 정확도: cases where every marker is honest AND counts match. */
  markerAccuracy: number;
}

export const BRIEF_THRESHOLDS = { cases: 10, precision: 1, markerAccuracy: 0.9 };

export function briefTotalsOf(scores: readonly BriefCaseScore[]): BriefTotals {
  const claims = scores.reduce((sum, score) => sum + score.claims, 0);
  const precision =
    claims === 0
      ? 0
      : scores.reduce((sum, score) => sum + score.citesProvided, 0) / claims;
  const okCases = scores.filter(
    (score) =>
      score.schemaValid &&
      score.claims > 0 &&
      score.citesProvided === score.claims &&
      score.honestMarkers === score.claims &&
      score.countsOk,
  ).length;
  return {
    cases: scores.length,
    claims,
    precision,
    markerAccuracy: scores.length === 0 ? 0 : okCases / scores.length,
  };
}

export function briefFailuresOf(totals: BriefTotals): string[] {
  const failures: string[] = [];
  if (totals.cases < BRIEF_THRESHOLDS.cases) {
    failures.push(`브리프 셋이 ${totals.cases}건입니다 (${BRIEF_THRESHOLDS.cases}건 필요)`);
  }
  if (totals.precision < BRIEF_THRESHOLDS.precision) {
    failures.push(`브리프 증거 인용 정확성 ${(totals.precision * 100).toFixed(1)}%`);
  }
  if (totals.markerAccuracy < BRIEF_THRESHOLDS.markerAccuracy) {
    failures.push(`브리프 근거 없음 마커 정확도 ${(totals.markerAccuracy * 100).toFixed(1)}%`);
  }
  return failures;
}
