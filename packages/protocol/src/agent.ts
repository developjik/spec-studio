import { z } from 'zod';
import { ObjectIdSchema } from './ids';

/**
 * The agent run surface (E3 F1). A run is operational state, not project
 * content: it lives in `run`/`run_log`/`checkpoint` (v17), never crosses the
 * bundle boundary (A5), and its only way to change the project is the same
 * decision card a person already knows. Everything the runtime needs to agree
 * on — the state machine vocabulary, the declarative tool whitelist, the
 * conversation shape — is declared here so the daemon, the store and the
 * runner all read one definition (A3: data, not code plugins).
 */

export const RUN_STATES = [
  'queued',
  'running',
  'waiting',
  'needs_input',
  'review',
  'done',
  'failed',
  'cancelled',
] as const;
export const RunStateSchema = z.enum(RUN_STATES);
export type RunState = (typeof RUN_STATES)[number];

/** A run ends here; nothing may leave these states (AC-2's fixed points). */
export const RUN_TERMINAL_STATES = ['done', 'failed', 'cancelled'] as const;
export type RunTerminalState = (typeof RUN_TERMINAL_STATES)[number];

/** The run's own vocabulary, kept in step with the v17 CHECK constraint. */
export const RUN_MODES = ['plan', 'build', 'research'] as const;
export const RunModeSchema = z.enum(RUN_MODES);
export type RunMode = (typeof RUN_MODES)[number];

export const RunIdSchema = z
  .string()
  .regex(/^R_[A-Za-z0-9_-]{8,24}$/, { message: 'run id must start with R_' });
export type RunId = z.infer<typeof RunIdSchema>;

/** One row of `run`, as the store reads and writes it. */
export const RunRecordSchema = z.object({
  id: RunIdSchema,
  projectId: z.string().min(1),
  /** specnode | pin | idea — the v17 trigger enforces the kind. */
  taskId: ObjectIdSchema,
  agent: z.string().trim().min(1).max(40),
  mode: RunModeSchema,
  state: RunStateSchema,
  /** Set when the daemon restarts under a live run; cleared by run.resume. */
  interrupted: z.boolean(),
  /** When the run last went outward — to the person (needs_input · review). */
  outwardAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** One `run_log` line. `event` carries the machine's structured records. */
export const RUN_LOG_STREAMS = ['stdout', 'stderr', 'event'] as const;
export const RunLogStreamSchema = z.enum(RUN_LOG_STREAMS);
export type RunLogStream = (typeof RUN_LOG_STREAMS)[number];

/**
 * A declared tool (A3 · AC-4). The whitelist is data the daemon owns: a tool
 * that is not in the list the runner received cannot be executed — the call
 * is blocked and journaled, never silently dropped or attempted.
 */
export const AgentToolSpecSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, {
    message: 'tool name is 1-40 lowercase letters, digits or _',
  }),
  description: z.string().trim().min(1).max(300),
  /** A JSON-Schema object for the tool's input — declared, never executed. */
  inputSchema: z.record(z.string(), z.unknown()),
});
export type AgentToolSpec = z.infer<typeof AgentToolSpecSchema>;

/**
 * The one tool every run carries: asking the person. It is declared like any
 * other tool so the model sees it in the same whitelist, and executing it is
 * what moves a run to `needs_input` — the question itself, never a guess.
 */
export const ASK_HUMAN_TOOL: AgentToolSpec = Object.freeze({
  name: 'ask_human',
  description: '사람에게 질문합니다. 예산·범위 확인 등 런 계속 진행에 필요한 답을 받습니다.',
  inputSchema: {
    type: 'object',
    properties: { question: { type: 'string', description: '질문 한 문장' } },
    required: ['question'],
  },
});

/**
 * Tool №1 of web research (E3 F2): search the web and fetch a page's body —
 * one call, both halves. Returns `results`: title · url · excerpt per hit;
 * the model cites those urls verbatim in `claims[].sourceUrls`, and the
 * runner washes any url the tool never returned (AC-3). Fetching happens in
 * the daemon process only (AC-4) — the pure runner sees a port, never a
 * socket. No key means an honest '웹 검색 불가' failure, never a silent
 * fallback.
 */
export const WEB_SEARCH_TOOL: AgentToolSpec = Object.freeze({
  name: 'web_search',
  description:
    '웹을 검색해 출처(url)와 발췌를 가져옵니다. 인용은 결과의 url을 그대로 쓰고, 발췌 이상 복사하지 않습니다.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '검색 질의' },
      url: { type: 'string', description: '본문을 가져올 페이지 url (선택)' },
    },
    required: ['query'],
  },
});

export const AgentToolCallSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(40),
  input: z.unknown(),
});
export type AgentToolCall = z.infer<typeof AgentToolCallSchema>;

/** The multi-turn conversation a run carries (F1 `messages[]`). */
export const AgentMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), text: z.string().max(16_000) }),
  z.object({ role: z.literal('user'), text: z.string().max(16_000) }),
  z.object({
    role: z.literal('assistant'),
    text: z.string().max(16_000).default(''),
    toolCalls: z.array(AgentToolCallSchema).max(16).default([]),
  }),
  z.object({
    role: z.literal('tool'),
    toolCallId: z.string().min(1).max(80),
    name: z.string().min(1).max(40),
    ok: z.boolean(),
    /** The tool's answer, already stringified by the executor. */
    output: z.string().max(16_000),
  }),
]);
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

/**
 * What a run's final turn hands back: a research brief draft for the task at
 * hand — the same trust boundary the single-shot path already validates, so
 * a run's card is a `proposal.create` exactly like a person's would be.
 */
export const AgentFinalSchema = z.object({
  action: z.literal('final'),
  draft: z.unknown(),
});
export const AgentAskSchema = z.object({
  action: z.literal('ask'),
  question: z.string().trim().min(1).max(1000),
});
