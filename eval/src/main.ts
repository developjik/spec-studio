import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execute, type IdKind } from '@spec-studio/core';
import { AiDraftError, AiProviderError, requestBriefDraft, requestGraphDraft } from '@spec-studio/ai';
import type { AiBriefDraft, EditableNodeType, GraphProposal } from '@spec-studio/protocol';
import { loadGoldenCases, projectFor, type GoldenCase, type LoadedCase } from './cases.js';
import {
  briefProject,
  briefTotalsOf,
  evidenceIdsOf,
  fallbackBrief,
  loadBriefCases,
  scoreBriefCase,
  briefFailuresOf,
  type BriefCaseScore,
} from './brief.js';
import { failuresOf, scoreProposal, totalsOf, type CaseScore } from './score.js';

/**
 * `pnpm eval` — the quality gate for the proposal engine.
 *
 * It scores the fallback and a live model on the same 30 Korean cases: the
 * rule extractor in `--mock` (deterministic, no network, what CI runs), a real
 * provider in `--live`, and `--mock` automatically when no key is present.
 * The numbers are the point: without them "AI 제안" is a claim, not a feature.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(HERE, '..', 'golden');
const AT = '2026-11-19T09:00:00.000Z';

interface Options {
  mode: 'mock' | 'live';
  provider: 'anthropic' | 'openai';
  model: string;
  endpoint: string | null;
  apiKey: string | null;
}

function parseOptions(argv: readonly string[]): Options {
  const envKey = (name: string) => {
    const value = process.env[name];
    return value === undefined || value.trim() === '' ? null : value.trim();
  };
  const providerArg = argv.find((arg) => arg.startsWith('--provider='))?.split('=')[1];
  const provider = providerArg === 'openai' || providerArg === 'anthropic' ? providerArg : 'anthropic';
  const modelArg = argv.find((arg) => arg.startsWith('--model='))?.split('=')[1];
  const endpointArg = argv.find((arg) => arg.startsWith('--endpoint='))?.split('=')[1];
  const apiKey =
    (provider === 'anthropic' ? envKey('ANTHROPIC_API_KEY') : envKey('OPENAI_API_KEY')) ?? null;
  const wantsLive = argv.includes('--live');
  const wantsMock = argv.includes('--mock');
  const mode: 'mock' | 'live' = wantsMock ? 'mock' : wantsLive ? 'live' : apiKey === null ? 'mock' : 'live';
  return {
    mode,
    provider,
    model:
      modelArg ??
      (provider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o-mini'),
    endpoint: endpointArg ?? null,
    apiKey,
  };
}

function idFactory(): (kind: IdKind, nodeType?: EditableNodeType) => string {
  let seq = 1000;
  return (kind, nodeType) => {
    seq += 1;
    const suffix = `${seq}eval`;
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

/** The deterministic baseline: the rule extractor the app already ships. */
function ruleProposal(testCase: GoldenCase): GraphProposal {
  const project = projectFor(testCase);
  return execute(project, { type: 'graph.proposal.create' }, { at: AT, nextId: idFactory() }).project
    .graphProposal as GraphProposal;
}

async function liveProposal(testCase: GoldenCase, options: Options): Promise<GraphProposal> {
  const project = projectFor(testCase);
  if (options.apiKey === null) {
    throw new Error('API 키가 없습니다. ANTHROPIC_API_KEY 또는 OPENAI_API_KEY를 설정하세요.');
  }
  const { draft } = await requestGraphDraft({
    provider: options.provider,
    apiKey: options.apiKey,
    model: options.model,
    endpoint: options.endpoint,
    project,
  });
  // The same adoption path the daemon uses: draft → card, with the project's
  // own pins deciding what counts as evidence.
  return execute(
    project,
    {
      type: 'graph.proposal.create',
      draft,
      source: 'llm',
      provider: options.provider,
      model: options.model,
    },
    { at: AT, nextId: idFactory() },
  ).project.graphProposal as GraphProposal;
}

function pad(value: string, width: number, align: 'left' | 'right' = 'left'): string {
  return align === 'left' ? value.padEnd(width) : value.padStart(width);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function printTable(scores: readonly CaseScore[]): void {
  console.log(
    `\n${pad('id', 9)}${pad('분류', 11)}${pad('스키마', 8)}${pad('타입', 7)}${pad('링크', 7)}${pad('핀근거', 8)}${pad('근거비율', 10)}${pad('초안', 6)}${pad('링크', 6)}`,
  );
  console.log('─'.repeat(72));
  for (const score of scores) {
    console.log(
      `${pad(score.id, 9)}${pad(score.category, 11)}${pad(score.schema ? 'OK' : '실패', 8)}` +
        `${pad(pct(score.types), 7)}${pad(pct(score.links), 7)}${pad(pct(score.pins), 8)}` +
        `${pad(pct(score.grounded), 10)}${pad(String(score.nodes), 6)}${pad(String(score.linksCreated), 6)}`,
    );
  }
}

function printBriefTable(scores: readonly BriefCaseScore[]): void {
  console.log(
    `\n${pad('id', 9)}${pad('분류', 12)}${pad('스키마', 8)}${pad('주장', 7)}${pad('근거', 7)}${pad('근거없음', 11)}${pad('인용정확', 10)}${pad('마커정확', 10)}`,
  );
  console.log('─'.repeat(72));
  for (const score of scores) {
    const cites = score.claims === 0 ? 0 : score.citesProvided / score.claims;
    const markers = score.claims === 0 ? 0 : score.honestMarkers / score.claims;
    console.log(
      `${pad(score.id, 9)}${pad(score.group, 12)}${pad(score.schemaValid ? 'OK' : '실패', 8)}` +
        `${pad(String(score.claims), 7)}${pad(String(score.grounded), 7)}${pad(String(score.ungrounded), 11)}` +
        `${pad(pct(cites), 10)}${pad(pct(markers), 10)}`,
    );
  }
}

/**
 * The brief set (§7-B-3). Mock grades the fallback the daemon ships; live
 * asks the real model the same question and is 참고치 — the gates stay the
 * same so a regression is visible either way.
 */
async function runBriefSet(options: Options): Promise<{ scores: BriefCaseScore[]; detail: string[] }> {
  const briefCases = loadBriefCases(GOLDEN_DIR);
  const scores: BriefCaseScore[] = [];
  const detail: string[] = [];
  for (const testCase of briefCases) {
    const providedIds = evidenceIdsOf(testCase);
    let draft: AiBriefDraft | null = null;
    try {
      if (options.mode === 'live') {
        const { project, ideaId } = briefProject(testCase);
        const answer = await requestBriefDraft({
          provider: options.provider,
          apiKey: options.apiKey ?? '',
          model: options.model,
          endpoint: options.endpoint,
          project,
          brief: { ideaId, evidenceIds: providedIds },
        });
        draft = answer.draft;
      } else {
        draft = fallbackBrief(testCase);
      }
    } catch (error) {
      if (error instanceof AiDraftError || error instanceof AiProviderError) {
        detail.push(`${testCase.id}: ${error.message}`);
      } else {
        detail.push(`${testCase.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    scores.push(scoreBriefCase(testCase, providedIds, draft));
  }
  return { scores, detail };
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const cases = loadGoldenCases(GOLDEN_DIR);
  const byCategory = cases.reduce<Record<string, number>>((counts, testCase) => {
    counts[testCase.category] = (counts[testCase.category] ?? 0) + 1;
    return counts;
  }, {});

  console.log('spec-studio · AI 제안 품질 eval');
  console.log(
    `모드 ${options.mode === 'mock' ? 'mock (로컬 규칙 폴백)' : `live (${options.provider} · ${options.model})`}`,
  );
  console.log(
    `골든셋 ${cases.length}건 — ${Object.entries(byCategory)
      .map(([category, count]) => `${category} ${count}`)
      .join(' · ')}`,
  );

  if (options.mode === 'live' && options.apiKey === null) {
    console.error('\n--live 를 쓰려면 API 키가 필요합니다 (ANTHROPIC_API_KEY / OPENAI_API_KEY).');
    return 2;
  }

  const scores: CaseScore[] = [];
  for (const testCase of cases as LoadedCase[]) {
    const project = projectFor(testCase);
    let proposal: GraphProposal | null = null;
    let schemaValid = false;
    let detail = '';
    try {
      proposal = options.mode === 'mock' ? ruleProposal(testCase) : await liveProposal(testCase, options);
      schemaValid = true;
    } catch (error) {
      if (error instanceof AiDraftError || error instanceof AiProviderError) {
        detail = error.message;
      } else {
        detail = error instanceof Error ? error.message : String(error);
      }
    }
    const score = scoreProposal(testCase, testCase.category, project, proposal, schemaValid);
    scores.push(score);
    if (detail !== '') console.log(`  ! ${testCase.id}: ${detail.slice(0, 140)}`);
  }

  printTable(scores);
  const totals = totalsOf(scores);
  const failures = failuresOf(totals);

  console.log('─'.repeat(72));
  console.log(
    `${pad('합계', 20)}${pad(pct(totals.schema), 8)}${pad(pct(totals.types), 7)}${pad(pct(totals.links), 7)}` +
      `${pad(pct(totals.pins), 8)}${pad(pct(totals.grounded), 10)}`,
  );
  console.log(
    `${pad('임계치', 20)}${pad('100%', 8)}${pad('≥85%', 7)}${pad('≥85%', 7)}${pad('≥90%', 8)}${pad('≥90%', 10)}`,
  );

  // ── the brief set (§7-B-3) ──────────────────────────────────────────
  const brief = await runBriefSet(options);
  printBriefTable(brief.scores);
  const briefTotals = briefTotalsOf(brief.scores);
  for (const line of brief.detail) console.log(`  ! ${line.slice(0, 140)}`);
  console.log('─'.repeat(72));
  console.log(
    `${pad('브리프 합계', 20)}${pad(`주장 ${briefTotals.claims}개`, 15)}${pad(pct(briefTotals.precision), 20)}` +
      pct(briefTotals.markerAccuracy),
  );
  console.log(`${pad('임계치', 20)}${pad('', 15)}${pad('100%', 20)}≥90%`);
  failures.push(...briefFailuresOf(briefTotals));

  if (failures.length > 0) {
    console.log(`\nFAIL — ${failures.join(' · ')}`);
    return 1;
  }
  console.log(`\nPASS — 골든 ${totals.cases}건 · 브리프 ${briefTotals.cases}건이 임계치를 넘었습니다.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
