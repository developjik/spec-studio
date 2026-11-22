import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentMessageSchema,
  AiBriefDraftSchema,
  ASK_HUMAN_TOOL,
  WEB_SEARCH_TOOL,
  type AgentMessage,
  type AgentToolCall,
  type AiBriefDraft,
} from '@spec-studio/protocol';
import { driveRun, washBriefDraft, type JournalLine, type ModelPort, type RunOutcome } from '@spec-studio/agent';

/**
 * The agent-research set (E3 F2 · AC-3): the run's own driver, a scripted
 * model and a scripted web_search tool — the exact loop the daemon runs,
 * scored on the one law that matters: a brief's web citations are grounded
 * or gone. The wash here is the same pure function the daemon calls before
 * the card, so the gate and the product cannot drift apart.
 */

export interface AgentResearchToolResult {
  title: string;
  url: string;
  excerpt: string;
}

interface ScriptTurn {
  toolCalls?: AgentToolCall[];
  final?: AiBriefDraft;
}

export interface AgentResearchCase {
  id: string;
  note: string;
  group: string;
  toolResults: AgentResearchToolResult[];
  modelTurns: ScriptTurn[];
  expect: {
    keptUrls: string[];
    washedUrls: string[];
    ungroundedAfter: number;
    askedQuestion?: string;
  };
}

export interface AgentResearchScore {
  id: string;
  group: string;
  /** The run reached a final draft (not a stall, not a format failure). */
  reachedFinal: boolean;
  /** Schema-valid after the wash — a washed claim keeps the honest marker. */
  schemaValid: boolean;
  /** Urls that survived on the card — all must be tool-reported. */
  keptUrls: string[];
  /** Every kept url is one the tool reported (AC-3: 100%). */
  citationAccuracy: boolean;
  /** The wash removed exactly the invented urls the case planted. */
  washExact: boolean;
  /** Ungrounded claims after the wash match the case's expectation. */
  ungroundedExact: boolean;
  /** The question the run asked, when the case routes through needs_input. */
  askedQuestion: string | null;
  pass: boolean;
}

export function loadAgentResearchCases(goldenDir: string): AgentResearchCase[] {
  const raw = JSON.parse(readFileSync(join(goldenDir, 'agent-research.json'), 'utf8')) as AgentResearchCase[];
  return raw;
}

function scriptedModel(turns: ScriptTurn[]): ModelPort {
  let index = 0;
  return {
    async turn(request) {
      if (request.signal?.aborted) throw new Error('aborted');
      const turn = turns[Math.min(index, turns.length - 1)] ?? {};
      index += 1;
      if (turn.final !== undefined) {
        return { text: JSON.stringify({ action: 'final', draft: turn.final }), toolCalls: [] };
      }
      return { text: '', toolCalls: turn.toolCalls ?? [] };
    },
  };
}

function scriptedToolbox(results: readonly AgentResearchToolResult[], executed: string[]) {
  const reported = new Set(results.map((row) => row.url));
  return {
    specs: () => [ASK_HUMAN_TOOL, WEB_SEARCH_TOOL],
    execute: async (call: AgentToolCall) => {
      executed.push(call.name);
      if (call.name === WEB_SEARCH_TOOL.name) {
        if (results.length === 0) {
          return { ok: true, output: JSON.stringify({ results: [], note: '검색 결과가 없습니다.' }) };
        }
        return { ok: true, output: JSON.stringify({ results }) };
      }
      if (call.name === ASK_HUMAN_TOOL.name) {
        const input = (call.input ?? {}) as { question?: string };
        return { ok: true, output: JSON.stringify({ asked: true, question: input.question ?? '' }) };
      }
      return { ok: false, output: '차단되었습니다: 선언되지 않은 도구입니다.' };
    },
    reportedUrls: reported,
  };
}

const SYSTEM: AgentMessage = {
  role: 'system',
  text: '리서치 에이전트 eval — 도구가 준 url만 인용하세요.',
};

export async function runAgentResearchCase(testCase: AgentResearchCase): Promise<AgentResearchScore> {
  const executed: string[] = [];
  const journalLines: JournalLine[] = [];
  const toolbox = scriptedToolbox(testCase.toolResults, executed);
  const model = scriptedModel(testCase.modelTurns);

  const drive = async (messages: AgentMessage[]): Promise<RunOutcome> =>
    driveRun({
      messages,
      model,
      toolbox,
      journal: {
        log: (stream, line) => {
          journalLines.push({ stream, line });
        },
      },
      isCancelled: async () => false,
      maxTurns: 12,
    });

  let messages: AgentMessage[] = [SYSTEM, { role: 'user', text: `과제: ${testCase.note}` }];
  let outcome = await drive(messages);

  // needs_input is a stop, not an end: answer and continue — the same road
  // run.answer takes in the daemon.
  let askedQuestion: string | null = null;
  if (outcome.kind === 'needs_input') {
    askedQuestion = outcome.question;
    outcome = await drive([
      ...outcome.messages,
      AgentMessageSchema.parse({ role: 'user', text: '사람의 답변: 전부 확인해 주세요.' }),
    ]);
  }
  messages = [];

  const score: AgentResearchScore = {
    id: testCase.id,
    group: testCase.group,
    reachedFinal: outcome.kind === 'final',
    schemaValid: false,
    keptUrls: [],
    citationAccuracy: false,
    washExact: false,
    ungroundedExact: false,
    askedQuestion,
    pass: false,
  };
  if (outcome.kind !== 'final') return score;

  const parsed = AiBriefDraftSchema.safeParse(outcome.draft);
  if (!parsed.success) return score;
  score.schemaValid = true;

  const washed = washBriefDraft(parsed.data, toolbox.reportedUrls);
  const keptUrls = washed.draft.claims.flatMap((claim) => claim.sourceUrls);
  score.keptUrls = keptUrls;
  score.citationAccuracy = keptUrls.every((url) => toolbox.reportedUrls.has(url));
  score.washExact =
    washed.removedUrls.length === testCase.expect.washedUrls.length &&
    testCase.expect.washedUrls.every((url) => washed.removedUrls.includes(url));
  const ungroundedAfter = washed.draft.claims.filter((claim) => claim.ungrounded).length;
  score.ungroundedExact = ungroundedAfter === testCase.expect.ungroundedAfter;
  const keptExact =
    keptUrls.length === testCase.expect.keptUrls.length &&
    testCase.expect.keptUrls.every((url) => keptUrls.includes(url));
  const askedOk = testCase.expect.askedQuestion === undefined || askedQuestion === testCase.expect.askedQuestion;

  score.pass =
    score.reachedFinal &&
    score.schemaValid &&
    score.citationAccuracy &&
    score.washExact &&
    score.ungroundedExact &&
    keptExact &&
    askedOk;
  return score;
}

export function agentResearchFailuresOf(scores: readonly AgentResearchScore[]): string[] {
  const failures: string[] = [];
  const passed = scores.filter((score) => score.pass).length;
  if (passed !== scores.length) {
    failures.push(`에이전트 인용 ${passed}/${scores.length} (임계치 100%)`);
  }
  const invented = scores.some((score) => !score.citationAccuracy);
  if (invented) failures.push('세척 후 카드에 도구 외 출처 잔존 (AC-3 위반)');
  return failures;
}
