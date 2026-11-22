import {
  AI_DEFAULT_MODELS,
  AI_ENV_KEYS,
  AiBriefDraftSchema,
  ASK_HUMAN_TOOL,
  TAVILY_ENV_KEY,
  WEB_SEARCH_TOOL,
  type AgentMessage,
  type AgentToolCall,
  type AgentToolSpec,
  type Command,
  type Project,
  type RunRecord,
} from '@spec-studio/protocol';
import { driveRun, isTerminalRunState, washBriefDraft, type ModelPort, type RunOutcome } from '@spec-studio/agent';
import { callModelStream } from '@spec-studio/ai';
import type { SqliteStore } from '@spec-studio/store';

/**
 * The daemon's half of the runtime (E3 F1): it picks queued runs up, drives
 * the pure runner over ports, and maps each stopping point onto the store.
 *
 * Three walls hold here as nowhere else:
 *  - the model is reached only through this process — external fetch is a
 *    daemon concern, never the runner's (AC-4's "데몬 경로만");
 *  - the tool whitelist is what this service declares: W1 ships exactly one
 *    tool, ask_human; web research arrives in W3 as another declared tool;
 *  - the run's only write to the project is a proposal.create, exactly like
 *    the single-shot path — never an adoption (A4: no auto-adopt).
 */

export interface DeclaredTool {
  spec: AgentToolSpec;
  execute(call: AgentToolCall, signal?: AbortSignal): Promise<{ ok: boolean; output: string }>;
}

export interface AgentRuntimeOptions {
  store: SqliteStore;
  env?: Record<string, string | undefined>;
  /** Tests inject a scripted model; production resolves keys and calls out. */
  modelPort?: ModelPort;
  /** Extra declared tools (W3: web research). W1 ships ask_human only. */
  tools?: DeclaredTool[];
  fetchImpl?: typeof fetch;
  /**
   * W3 waiting 데드 상태 — the inactivity backstop. A live run
   * (running · waiting) with no activity for this long parks on the
   * existing `interrupted` flag; run.resume · run.cancel are the way out.
   * Activity is journal lines, stream deltas and state moves — not a bare
   * wall clock. Default 10 minutes; tests shrink it.
   */
  waitingTimeoutMs?: number;
  /** How often the backstop sweeps the activity clock (default 30s). */
  sweepIntervalMs?: number;
}

export const AGENT_SYSTEM_PROMPT = [
  '당신은 스펙 스튜디오의 리서치 에이전트입니다.',
  '과제(아이디어)를 조사해 결정카드(리서치 브리프 초안)를 만드는 것이 목적입니다.',
  '진행에 필요한 정보가 있으면 ask_human 도구로 사람에게 물으십시오.',
  '웹 조사는 web_search 도구로만 하십시오. 결과의 url을 그대로 인용하고 발췌 이상 복사하지 마십시오.',
  '최종 답변은 다음 JSON 중 하나만 가능합니다:',
  '{"action":"ask","question":"사람에게 할 질문 한 문장"}',
  '{"action":"final","draft":{"title":"…","summary":"…","claims":[{"text":"…","sourceUrls":["web_search가 반환한 url"],"evidenceRefs":[],"ungrounded":false}]}}',
  '주장에는 근거 참조(sourceUrls·evidenceRefs) 또는 ungrounded 표시가 반드시 있어야 합니다.',
  '도구가 반환하지 않은 출처는 절대 지어내지 마십시오 — 근거가 없으면 ungrounded: true로 솔직하게 표시하십시오.',
  '도구를 쓰겠다고 말만 하지 말고 도구를 호출하십시오.',
].join('\n');

export class AgentService {
  readonly #store: SqliteStore;
  readonly #options: AgentRuntimeOptions;
  readonly #aborts = new Map<string, AbortController>();
  /** W3 backstop: runId → last activity instant (journal · stream · state). */
  readonly #lastActivity = new Map<string, number>();
  readonly #waitingTimeoutMs: number;
  readonly #sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(options: AgentRuntimeOptions) {
    this.#store = options.store;
    this.#options = options;
    this.#waitingTimeoutMs = options.waitingTimeoutMs ?? 10 * 60_000;
    const sweepMs = options.sweepIntervalMs ?? 30_000;
    if (sweepMs > 0) {
      this.#sweeper = setInterval(() => this.#sweep(), sweepMs);
      this.#sweeper.unref?.();
    }
  }

  /** The daemon closes: the backstop timer stops with it. */
  stop(): void {
    if (this.#sweeper !== undefined) clearInterval(this.#sweeper);
  }

  /**
   * W3 waiting 데드 상태, 트리거 3 (백스톱): a live run that stopped
   * making progress parks on `interrupted` — the existing flag, never a new
   * state — and AC-2's resume/cancel UX takes over. needs_input · review
   * wait on a person (A4) and are never swept; parkRun enforces the same.
   */
  #sweep(): void {
    const now = Date.now();
    for (const [runId, at] of this.#lastActivity) {
      if (now - at < this.#waitingTimeoutMs) continue;
      const record = this.#store.getRun(runId);
      if (record === null || (record.state !== 'running' && record.state !== 'waiting')) {
        this.#lastActivity.delete(runId);
        continue;
      }
      const waitedSeconds = Math.round((now - at) / 1000);
      // Abort the in-flight loop first — the settle path sees the flag the
      // parkRun below raised and leaves the record alone for the person. The
      // loop slot frees here, not in the old loop's finally: a resume that
      // lands inside the unwind window must be able to start a new loop.
      this.#aborts.get(runId)?.abort();
      this.#aborts.delete(runId);
      this.#store.parkRun(runId, 'inactivity_timeout', `활동 없이 ${waitedSeconds}초`);
      this.#lastActivity.delete(runId);
    }
  }

  #tick(runId: string): void {
    this.#lastActivity.set(runId, Date.now());
  }

  /** The run's abort switch — run.cancel lands here instantly (AC-2). */
  abort(runId: string): void {
    this.#aborts.get(runId)?.abort();
  }

  listRun(runId: string): RunRecord | null {
    return this.#store.getRun(runId);
  }

  /**
   * Picks a queued run up and drives it to its next stopping point. Fire and
   * forget by design: the HTTP request that caused it has already answered.
   */
  pickUpRun(projectId: string, runId: string, extraUserMessage?: string): void {
    const record = this.#store.getRun(runId);
    if (record === null) return;
    if (record.state !== 'queued') return;
    if (this.#aborts.has(runId)) return; // one loop per run
    const controller = new AbortController();
    this.#aborts.set(runId, controller);
    void this.#drive(projectId, runId, controller, extraUserMessage).finally(() => {
      this.#aborts.delete(runId);
    });
  }

  /** A decision on a run's card is what 'done' means for the run. */
  closeDecidedRun(project: Project, proposalId: string): void {
    const proposal = project.proposals.find((candidate) => candidate.id === proposalId);
    if (proposal?.authorId == null) return;
    const record = this.#store.getRun(proposal.authorId);
    if (record === null || record.state !== 'review') return;
    this.#store.transitionRun(proposal.authorId, 'done');
  }

  async #drive(
    projectId: string,
    runId: string,
    controller: AbortController,
    extraUserMessage?: string,
  ): Promise<void> {
    const store = this.#store;
    // AC-3's ground truth: every url the run's web_search tool actually
    // returned. The final wash keeps the card free of invented sources.
    const reportedUrls = new Set<string>();
    // AC-9: model deltas land in run_log as stdout — coalesced so one
    // token is not one row. The stream endpoint replays them as progress.
    let pendingText = '';
    const flushText = () => {
      if (pendingText !== '') {
        store.appendRunLog(runId, 'stdout', pendingText);
        pendingText = '';
      }
    };
    const onText = (delta: string) => {
      this.#tick(runId);
      pendingText += delta;
      if (pendingText.length >= 120 || pendingText.endsWith('\n')) flushText();
    };
    try {
      store.transitionRun(runId, 'running');
      this.#tick(runId);
      const messages = this.#restoreMessages(runId);
      if (extraUserMessage !== undefined) {
        messages.push({ role: 'user', text: extraUserMessage });
      }
      const record = store.getRun(runId);
      if (record === null) return;
      const project = await store.readProject(projectId);
      if (project === null) throw new Error(`프로젝트가 없습니다: ${projectId}`);
      if (messages.length === 0) {
        messages.push({ role: 'system', text: AGENT_SYSTEM_PROMPT });
        messages.push({ role: 'user', text: `과제: ${record.taskId} (${record.mode} 런)을 조사해 주세요.` });
      }

      // E3 F2 배지: when the run carries web research, say up front whether it
      // can actually search — an unavailable key is a badge, never a surprise.
      const toolbox = this.#toolbox(reportedUrls);
      if (toolbox.specs().some((spec) => spec.name === WEB_SEARCH_TOOL.name)) {
        const hasKey = ((this.#options.env ?? {})[TAVILY_ENV_KEY] ?? '').trim() !== '';
        store.appendRunLog(
          runId,
          'event',
          JSON.stringify({ web_search: hasKey ? 'available' : 'unavailable', ...(hasKey ? {} : { reason: 'no_api_key' }) }),
        );
      }

      const outcome = await driveRun({
        messages,
        model: this.#modelPort(),
        toolbox,
        journal: {
          log: (stream, line) => {
            this.#tick(runId);
            store.appendRunLog(runId, stream, line);
          },
        },
        onText,
        isCancelled: async () => {
          if (controller.signal.aborted) return true;
          const current = store.getRun(runId);
          return current === null || current.state === 'cancelled';
        },
        maxTurns: 12,
      });
      flushText();

      const checkpointSeq = (store.latestCheckpoint(runId)?.seq ?? 0) + 1;
      store.saveCheckpoint(runId, checkpointSeq, JSON.stringify({ messages: outcome.messages }));

      await this.#settle(projectId, runId, record, outcome, project, reportedUrls);
    } catch (error) {
      flushText();
      // The honest exits: cancelled by command, or a failure the person sees.
      const current = store.getRun(runId);
      if (current === null || current.state === 'cancelled') return;
      // W3: a parked run (backstop or provider error) is the person's now —
      // the sweep already answered them; this loop only winds down.
      if (current.interrupted && !isTerminalRunState(current.state)) return;
      if (current.state !== 'running' && current.state !== 'waiting') return;
      store.appendRunLog(runId, 'stderr', error instanceof Error ? error.message : String(error));
      try {
        store.transitionRun(runId, 'failed');
      } catch {
        // already terminal — the state machine has the last word
      }
    } finally {
      this.#lastActivity.delete(runId);
    }
  }

  async #settle(
    projectId: string,
    runId: string,
    record: RunRecord,
    outcome: RunOutcome,
    project: Project,
    reportedUrls: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const store = this.#store;
    // W3: a parked run is waiting on the person's resume or cancel — every
    // machine verdict below would overwrite their decision, so none runs.
    // A run already resumed (queued) belongs to its new loop the same way.
    // The checkpoint (#drive saved it) holds the conversation as it stood.
    {
      const now = store.getRun(runId);
      if (now === null) return;
      if (now.interrupted && !isTerminalRunState(now.state)) return;
      if (now.state === 'queued') return;
    }
    if (outcome.kind === 'cancelled') {
      const current = store.getRun(runId);
      if (current !== null && current.state !== 'cancelled') store.transitionRun(runId, 'cancelled');
      return;
    }
    if (outcome.kind === 'needs_input') {
      store.transitionRun(runId, 'needs_input');
      return;
    }
    if (outcome.kind === 'failed') {
      if (outcome.cause === 'model') {
        // W3 이벤트 우선 트리거 ②: a confirmed provider/network failure parks
        // on `interrupted` instead of dying — the key may come back, the
        // network may heal, and run.resume picks up from the checkpoint.
        store.parkRun(runId, 'provider_error', outcome.reason.slice(0, 200));
        return;
      }
      store.appendRunLog(runId, 'stderr', outcome.reason);
      store.transitionRun(runId, 'failed');
      return;
    }

    // final: the run's one write — a decision card, never an adoption (A4).
    const draft = AiBriefDraftSchema.safeParse(outcome.draft);
    if (!draft.success) {
      store.appendRunLog(
        runId,
        'stderr',
        `브리프 초안이 형식에 맞지 않습니다: ${draft.error.issues[0]?.message ?? ''}`,
      );
      store.transitionRun(runId, 'failed');
      return;
    }
    // AC-3 (E3 F2): wash the web citations against what the run's own
    // web_search reported. A url the tool never returned never reaches the
    // card — the claim keeps the honest ungrounded marker instead (환각
    // 출처 0), and the journal records every wash for the eval to count.
    const washed = washBriefDraft(draft.data, reportedUrls);
    if (washed.removedUrls.length > 0) {
      store.appendRunLog(
        runId,
        'event',
        JSON.stringify({ hallucinated_refs: washed.removedUrls }),
      );
    }
    const doc = project.docs.find((candidate) => candidate.kind === 'research') ?? project.docs[0];
    if (doc === undefined) {
      store.appendRunLog(runId, 'stderr', '리서치 문서가 없어 카드를 올릴 수 없습니다');
      store.transitionRun(runId, 'failed');
      return;
    }
    await store.execute(projectId, {
      type: 'proposal.create',
      docId: doc.id,
      draft: washed.draft,
      source: 'llm',
      runId,
      ...(record.taskId.startsWith('I_') ? { ideaId: record.taskId } : {}),
    });
    store.appendRunLog(runId, 'event', JSON.stringify({ card: true, taskId: record.taskId }));
    store.transitionRun(runId, 'review');
  }

  #restoreMessages(runId: string): AgentMessage[] {
    const checkpoint = this.#store.latestCheckpoint(runId);
    if (checkpoint !== null) {
      try {
        const parsed = JSON.parse(checkpoint.summary) as { messages?: AgentMessage[] };
        if (Array.isArray(parsed.messages)) return parsed.messages;
      } catch {
        // a broken checkpoint restarts the conversation — the honest fallback
      }
    }
    return [];
  }

  #toolbox(reportedUrls?: Set<string>) {
    const declared = this.#options.tools ?? [];
    const map = new Map(declared.map((tool) => [tool.spec.name, tool]));
    return {
      specs: () => [ASK_HUMAN_TOOL, ...declared.map((tool) => tool.spec)],
      execute: async (call: AgentToolCall, signal?: AbortSignal) => {
        if (call.name === ASK_HUMAN_TOOL.name) {
          const input = (call.input ?? {}) as { question?: string };
          return { ok: true, output: JSON.stringify({ asked: true, question: input.question ?? '' }) };
        }
        const tool = map.get(call.name);
        if (tool === undefined) {
          return { ok: false, output: '차단되었습니다: 선언되지 않은 도구입니다.' };
        }
        const outcome = await tool.execute(call, signal);
        // AC-3: collect the urls web_search actually reported — the wash's
        // ground truth. Only ok answers carry citations worth trusting.
        if (call.name === WEB_SEARCH_TOOL.name && outcome.ok && reportedUrls !== undefined) {
          try {
            const parsed = JSON.parse(outcome.output) as { results?: Array<{ url?: string }> };
            for (const row of parsed.results ?? []) {
              if (typeof row.url === 'string' && row.url !== '') reportedUrls.add(row.url);
            }
          } catch {
            // a non-JSON tool answer contributes no ground truth
          }
        }
        return outcome;
      },
    };
  }

  #modelPort(): ModelPort {
    if (this.#options.modelPort !== undefined) return this.#options.modelPort;
    // Production: resolve the first provider with a key, honestly. No key,
    // no run — the person sees the failure, never a silent fallback.
    const env = this.#options.env ?? {};
    const provider = (['anthropic', 'openai'] as const).find((candidate) => {
      const key = env[AI_ENV_KEYS[candidate]];
      return key !== undefined && key.trim() !== '';
    });
    if (provider === undefined) {
      return {
        async turn() {
          throw new Error('에이전트 런에 쓸 API 키가 없습니다 (ANTHROPIC_API_KEY 또는 OPENAI_API_KEY)');
        },
      };
    }
    const apiKey = (env[AI_ENV_KEYS[provider]] ?? '').trim();
    const model = AI_DEFAULT_MODELS[provider];
    return {
      turn: (request) =>
        callModelStream(
          {
            provider,
            apiKey,
            model,
            messages: request.messages,
            tools: request.tools,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            ...(this.#options.fetchImpl === undefined ? {} : { fetchImpl: this.#options.fetchImpl }),
          },
          request.onText,
        ),
    };
  }
}

/**
 * The commands route knows the outcome; this maps a person's command onto the
 * service's wake-ups so the store's state change actually starts work.
 */
export function dispatchAgentCommand(
  service: AgentService | undefined,
  projectId: string,
  command: Command,
  outcome: { project: Project; events: ReadonlyArray<{ type: string; run?: RunRecord }> },
): void {
  if (service === undefined) return;
  switch (command.type) {
    case 'run.start': {
      const run = outcome.events.find((event) => event.type === 'run.started')?.run;
      if (run !== undefined) service.pickUpRun(projectId, run.id);
      return;
    }
    case 'run.answer':
      service.pickUpRun(projectId, command.runId, `사람의 답변: ${command.text}`);
      return;
    case 'run.resume': {
      const run = service.listRun(command.runId);
      if (run !== null && run.state === 'queued') service.pickUpRun(projectId, command.runId);
      return;
    }
    case 'run.cancel':
      service.abort(command.runId);
      return;
    case 'proposal.adopt':
    case 'proposal.reject':
      service.closeDecidedRun(outcome.project, command.proposalId);
      return;
    default:
      return;
  }
}
