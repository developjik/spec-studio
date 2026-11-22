import {
  AI_DEFAULT_MODELS,
  AI_ENV_KEYS,
  AiBriefDraftSchema,
  ASK_HUMAN_TOOL,
  type AgentMessage,
  type AgentToolCall,
  type AgentToolSpec,
  type Command,
  type Project,
  type RunRecord,
} from '@spec-studio/protocol';
import { driveRun, type ModelPort, type RunOutcome } from '@spec-studio/agent';
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
}

export const AGENT_SYSTEM_PROMPT = [
  '당신은 스펙 스튜디오의 리서치 에이전트입니다.',
  '과제(아이디어)를 조사해 결정카드(리서치 브리프 초안)를 만드는 것이 목적입니다.',
  '진행에 필요한 정보가 있으면 ask_human 도구로 사람에게 물으십시오.',
  '최종 답변은 다음 JSON 중 하나만 가능합니다:',
  '{"action":"ask","question":"사람에게 할 질문 한 문장"}',
  '{"action":"final","draft":{"title":"…","summary":"…","claims":[{"text":"…","evidenceRefs":[],"ungrounded":true}]}}',
  '주장에는 근거 참조(evidenceRefs) 또는 ungrounded 표시가 반드시 있어야 합니다. 출처를 지어내지 마십시오.',
  '도구를 쓰겠다고 말만 하지 말고 도구를 호출하십시오.',
].join('\n');

export class AgentService {
  readonly #store: SqliteStore;
  readonly #options: AgentRuntimeOptions;
  readonly #aborts = new Map<string, AbortController>();

  constructor(options: AgentRuntimeOptions) {
    this.#store = options.store;
    this.#options = options;
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
      pendingText += delta;
      if (pendingText.length >= 120 || pendingText.endsWith('\n')) flushText();
    };
    try {
      store.transitionRun(runId, 'running');
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

      const outcome = await driveRun({
        messages,
        model: this.#modelPort(),
        toolbox: this.#toolbox(),
        journal: { log: (stream, line) => store.appendRunLog(runId, stream, line) },
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

      await this.#settle(projectId, runId, record, outcome, project);
    } catch (error) {
      flushText();
      // The honest exits: cancelled by command, or a failure the person sees.
      const current = store.getRun(runId);
      if (current === null || current.state === 'cancelled') return;
      if (current.state !== 'running' && current.state !== 'waiting') return;
      store.appendRunLog(runId, 'stderr', error instanceof Error ? error.message : String(error));
      try {
        store.transitionRun(runId, 'failed');
      } catch {
        // already terminal — the state machine has the last word
      }
    }
  }

  async #settle(
    projectId: string,
    runId: string,
    record: RunRecord,
    outcome: RunOutcome,
    project: Project,
  ): Promise<void> {
    const store = this.#store;
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
    const doc = project.docs.find((candidate) => candidate.kind === 'research') ?? project.docs[0];
    if (doc === undefined) {
      store.appendRunLog(runId, 'stderr', '리서치 문서가 없어 카드를 올릴 수 없습니다');
      store.transitionRun(runId, 'failed');
      return;
    }
    await store.execute(projectId, {
      type: 'proposal.create',
      docId: doc.id,
      draft: draft.data,
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

  #toolbox() {
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
        return tool.execute(call, signal);
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
