import { z } from 'zod';
import { BlockIdSchema } from './doc.js';
import { EvidenceIdSchema } from './evidence.js';
import { EditableNodeTypeSchema, GraphLinkTypeSchema } from './graph.js';

/**
 * The AI proposal layer.
 *
 * A model never writes to the project. It answers with a draft — a small,
 * strictly shaped JSON object — and the daemon turns that draft into the same
 * decision card a person already knows: 채택 writes it in one transaction,
 * 되돌리기 restores `op_log.before`. The draft schema below is the whole trust
 * boundary: anything else in the answer (prose, extra keys, an id the project
 * does not have) is rejected before it reaches the store.
 *
 * `local` is not a provider you sign up for: it is the rule-based extractor
 * that already ships, selected explicitly so the fallback is a visible choice
 * rather than a silent one.
 */
export const AI_PROVIDERS = ['anthropic', 'openai', 'local'] as const;
export const AiProviderSchema = z.enum(AI_PROVIDERS);
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** The two providers that are called over the network. */
export const AI_REMOTE_PROVIDERS = ['anthropic', 'openai'] as const;
export type AiRemoteProvider = (typeof AI_REMOTE_PROVIDERS)[number];

export const AI_PROVIDER_LABEL: Record<AiProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI 호환',
  local: '로컬 규칙 (키 없음)',
};

/** Where the environment fallback key lives for each remote provider. */
export const AI_ENV_KEYS: Record<AiRemoteProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/** E3 F2: the web-research key (Tavily). Missing key is an honest
 * '웹 검색 불가' — never a silent fallback. BYOK 체인은 승계(E2). */
export const TAVILY_ENV_KEY = 'TAVILY_API_KEY';

/**
 * Where a resolved key came from. `subscription` exists in the enum as an
 * extension point only — no preset uses it and nothing resolves it yet.
 */
export const CredentialSourceSchema = z.enum(['request', 'keychain', 'env', 'subscription']);
export type CredentialSource = z.infer<typeof CredentialSourceSchema>;

/**
 * One place a key can come from (§6.1). The chain asks each port in order
 * and takes the first non-null answer; `store`/`erase` exist on the keychain
 * port only, so the other ports simply omit them.
 */
export interface CredentialPort {
  readonly source: CredentialSource;
  resolve(provider: AiRemoteProvider, presetId: string): Promise<string | null>;
  /** Keychain only: remember a key for a preset. */
  store?(provider: AiRemoteProvider, presetId: string, key: string): Promise<void>;
  /** Keychain only: forget a preset's key. */
  erase?(provider: AiRemoteProvider, presetId: string): Promise<void>;
}

/**
 * A gateway preset is data, not code: the wire protocol to speak, a base URL,
 * a default model, and whether a key is needed at all. Kept as a `.ts` data
 * array (not JSON) so it bundles with the package and stays type-checked;
 * the schema below is validated against it once at module load.
 */
export const AiPresetSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  label: z.string().min(1).max(60),
  provider: z.enum(AI_REMOTE_PROVIDERS),
  baseUrl: z.string().url().max(500).optional(),
  defaultModel: z.string().max(80).optional(),
  authMode: z.enum(['api-key', 'none', 'subscription']),
  docsUrl: z.string().url().optional(),
});
export type AiPreset = z.infer<typeof AiPresetSchema>;

/**
 * The built-in gateways. `subscription` sits in the auth enum as an extension
 * point only — no preset here uses it. Local servers need no key, and their
 * model name is typed by the person, so they carry no default.
 */
const PRESET_DATA = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-5',
    authMode: 'api-key',
  },
  {
    id: 'openai',
    label: 'OpenAI 호환',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    authMode: 'api-key',
  },
  {
    id: 'ollama',
    label: '로컬 서버 (Ollama)',
    provider: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    authMode: 'none',
  },
  {
    id: 'lmstudio',
    label: '로컬 서버 (LM Studio)',
    provider: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    authMode: 'none',
  },
  { id: 'custom', label: '사용자 지정', provider: 'openai', authMode: 'api-key' },
];

/** A bad preset row is a load-time failure, not a runtime surprise mid-request. */
export const AI_PRESETS: readonly AiPreset[] = z.array(AiPresetSchema).parse(PRESET_DATA);

export function findPreset(id: string): AiPreset | undefined {
  return AI_PRESETS.find((preset) => preset.id === id);
}

/** A reasonable first model name; the field stays editable on purpose. */
export const AI_DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: findPreset('anthropic')?.defaultModel ?? '',
  openai: findPreset('openai')?.defaultModel ?? '',
  local: '',
};

/** Derived from the presets — one source of truth for the vendor base URLs. */
export const AI_DEFAULT_ENDPOINTS: Record<AiRemoteProvider, string> = {
  anthropic: findPreset('anthropic')?.baseUrl ?? '',
  openai: findPreset('openai')?.baseUrl ?? '',
};

export const AI_PROPOSAL_MODES = ['graph', 'doc', 'brief', 'backlog'] as const;
export const AiProposalModeSchema = z.enum(AI_PROPOSAL_MODES);
export type AiProposalMode = (typeof AI_PROPOSAL_MODES)[number];

/** Where a card came from — the badge a person reads before deciding. */
export const AI_PROPOSAL_SOURCES = ['llm', 'rule'] as const;
export const AiProposalSourceSchema = z.enum(AI_PROPOSAL_SOURCES);
export type AiProposalSource = (typeof AI_PROPOSAL_SOURCES)[number];

export const AI_SOURCE_LABEL: Record<AiProposalSource, string> = {
  llm: 'LLM 제안',
  rule: '로컬 규칙 폴백',
};

/**
 * Provider · model · endpoint. These are not secrets, but they are also not
 * written to the database: they live in the window for the session, like the
 * key does.
 */
export const AiSettingsSchema = z.object({
  provider: AiProviderSchema.default('local'),
  model: z.string().trim().max(80).default(''),
  /** A custom base URL (local model server, gateway). `null` uses the default. */
  endpoint: z.string().trim().url().max(500).nullable().default(null),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

/** One draft object. `pins` are pin *numbers* — ids are the project's business. */
export const AiDraftNodeSchema = z.object({
  key: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,24}$/, { message: 'key must be 1-24 letters, digits, - or _' }),
  type: EditableNodeTypeSchema,
  title: z.string().trim().min(1).max(200),
  body: z.string().max(4000).default(''),
  /** The numbered pins this sentence stands on. Empty means ungrounded. */
  pins: z.array(z.number().int().min(1).max(9999)).max(6).default([]),
});
export type AiDraftNode = z.infer<typeof AiDraftNodeSchema>;

/**
 * A link inside a draft. Ids do not exist yet, so both ends are symbolic:
 *   item:<key>   a node this draft creates
 *   pin:<number> a pin already on the screen
 * An idea is a destination only — a draft may say a specnode came from an
 * idea (`idea:<I_id>`), never the other way around.
 */
export const AiDraftLinkSchema = z.object({
  type: GraphLinkTypeSchema,
  src: z
    .string()
    .regex(/^(item|pin):[A-Za-z0-9_-]{1,24}$/, {
      message: 'a draft ref is item:<key> or pin:<number>',
    }),
  dst: z
    .string()
    .regex(/^(item|pin|idea):[A-Za-z0-9_-]{1,24}$/, {
      message: 'a draft ref is item:<key>, pin:<number> or idea:<I_id>',
    }),
});
export type AiDraftLink = z.infer<typeof AiDraftLinkSchema>;

export const AiGraphDraftSchema = z.object({
  summary: z.string().trim().min(1).max(300),
  nodes: z.array(AiDraftNodeSchema).min(1).max(24),
  links: z.array(AiDraftLinkSchema).max(48).default([]),
});
export type AiGraphDraft = z.infer<typeof AiGraphDraftSchema>;

/** One paragraph the model would rewrite, with the pins the new text cites. */
export const AiDocPatchDraftSchema = z.object({
  blockId: BlockIdSchema,
  text: z.string().min(1).max(8000),
  pins: z.array(z.number().int().min(1).max(9999)).max(6).default([]),
});
export type AiDocPatchDraft = z.infer<typeof AiDocPatchDraftSchema>;

export const AiDocDraftSchema = z.object({
  summary: z.string().trim().min(1).max(300),
  patches: z.array(AiDocPatchDraftSchema).min(1).max(12),
});
export type AiDocDraft = z.infer<typeof AiDocDraftSchema>;

/** One claim of a research brief: what it says and what it stands on (F3-2). */
export const AiBriefClaimSchema = z.object({
  text: z.string().trim().min(1).max(800),
  /** Evidence ids only — an id the project does not have is rejected before 채택. */
  evidenceRefs: z.array(EvidenceIdSchema).max(6).default([]),
  /**
   * Web sources (E3 F2): URLs the run's web_search tool actually returned —
   * the runner washes any URL the tool never reported before the card is
   * written (AC-3: 환각 출처 0), so what lands here is grounded or gone.
   */
  sourceUrls: z.array(z.string().url().max(2048)).max(6).default([]),
  /** The honest marker: a claim with no source says so instead of inventing one. */
  ungrounded: z.boolean().default(false),
});
export type AiBriefClaim = z.infer<typeof AiBriefClaimSchema>;

/**
 * The brief draft (§5.4): a title, a summary and 1–12 claims. Every claim
 * either cites evidence or is marked `ungrounded` — that disjunction is the
 * whole trust boundary of AC-2, so it is enforced here, not in the UI.
 */
export const AiBriefDraftSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(300),
    claims: z.array(AiBriefClaimSchema).min(1).max(12),
  })
  .superRefine((value, ctx) => {
    for (const [index, claim] of value.claims.entries()) {
      if (claim.evidenceRefs.length === 0 && claim.sourceUrls.length === 0 && !claim.ungrounded) {
        ctx.addIssue({
          code: 'custom',
          message: '주장에는 근거 참조(evidenceRefs·sourceUrls) 또는 근거 없음 표시가 필요합니다',
          path: ['claims', index],
        });
      }
    }
  });
export type AiBriefDraft = z.infer<typeof AiBriefDraftSchema>;

/**
 * One backlog task (§4.1 ③): what to build and the pins/requests it stands
 * on. `evidenceRefs` names objects the project already has — a ref that is
 * not there is rejected at the card, never silently dropped — and a task
 * with none must carry the honest `ungrounded` flag, same rule as a claim.
 */
export const AiBacklogTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(''),
  /** Object ids this task grounds on (pins · specnodes · evidence · ideas). */
  evidenceRefs: z.array(z.string().min(1).max(60)).max(12).default([]),
  ungrounded: z.boolean().default(false),
});
export type AiBacklogTask = z.infer<typeof AiBacklogTaskSchema>;

/**
 * The backlog draft: one summary plus 1–50 ordered tasks. The array order is
 * the priority order — the draft carries no separate rank column.
 */
export const AiBacklogDraftSchema = z
  .object({
    summary: z.string().trim().min(1).max(300),
    tasks: z.array(AiBacklogTaskSchema).min(1).max(50),
  })
  .superRefine((value, ctx) => {
    for (const [index, task] of value.tasks.entries()) {
      if (task.evidenceRefs.length === 0 && !task.ungrounded) {
        ctx.addIssue({
          code: 'custom',
          message: '태스크에는 근거 참조 또는 근거 없음 표시가 필요합니다',
          path: ['tasks', index],
        });
      }
    }
  });
export type AiBacklogDraft = z.infer<typeof AiBacklogDraftSchema>;

/**
 * What the browser asks the daemon for. The key rides in this body or sits in
 * the OS keychain — nowhere else.
 */
export const AiProposalRequestSchema = z.object({
  mode: AiProposalModeSchema,
  provider: AiProviderSchema.default('local'),
  model: z.string().trim().max(80).default(''),
  endpoint: z.string().trim().url().max(500).nullable().optional(),
  /** Session memory only: the daemon forwards it and keeps no copy. */
  apiKey: z.string().max(400).nullable().optional(),
  /** Which gateway preset the request is aimed at, when it uses one. */
  presetId: z.string().max(60).optional(),
  /** Which document a `doc` or `brief` proposal edits; defaults to the project's document. */
  docId: z.string().max(40).optional(),
  /** A `brief` runs on this idea (F3-2), or on `topic` when no idea is picked. */
  ideaId: z.string().max(60).optional(),
  /** The evidence a brief should cite; omitted means everything on the board. */
  evidenceIds: z.array(z.string().max(60)).max(24).optional(),
  /** 주제 텍스트 when no idea is picked. */
  topic: z.string().trim().min(1).max(500).optional(),
});
export type AiProposalRequest = z.infer<typeof AiProposalRequestSchema>;

export const AiTestRequestSchema = z.object({
  provider: AiProviderSchema.default('local'),
  model: z.string().trim().max(80).default(''),
  endpoint: z.string().trim().url().max(500).nullable().optional(),
  apiKey: z.string().max(400).nullable().optional(),
  presetId: z.string().max(60).optional(),
});
export type AiTestRequest = z.infer<typeof AiTestRequestSchema>;

/**
 * The keychain routes. The store body carries the key once and gets a
 * boolean back — a stored key is write-only: never re-displayed, deletable
 * only. Erase needs nothing but the preset id.
 */
export const AiKeychainRequestSchema = z.object({
  presetId: z.string().min(1).max(60),
  apiKey: z.string().min(1).max(400),
});
export type AiKeychainRequest = z.infer<typeof AiKeychainRequestSchema>;

export const AiKeychainEraseSchema = AiKeychainRequestSchema.pick({ presetId: true });
export type AiKeychainEraseRequest = z.infer<typeof AiKeychainEraseSchema>;

/**
 * What the settings panel paints. `hasEnvKey` says only that a key exists in
 * the daemon's environment — never the key, never its length or prefix.
 */
export const AiProviderStatusSchema = z.object({
  provider: AiProviderSchema,
  hasEnvKey: z.boolean(),
  defaultModel: z.string().max(80),
  defaultEndpoint: z.string().max(500).nullable(),
});
export const AiStatusSchema = z.object({
  providers: z.array(AiProviderStatusSchema),
  /** The local rule extractor is always available; it needs no key. */
  localAvailable: z.boolean().default(true),
  /** Whether the daemon has a keychain port at all — the desktop app only. */
  keychainAvailable: z.boolean().default(false),
  /** Per preset: whether a key sits in the keychain. Booleans only, like `hasEnvKey`. */
  presets: z.array(z.object({ id: z.string(), hasKeychainKey: z.boolean() })).default([]),
});
export type AiStatus = z.infer<typeof AiStatusSchema>;

export const AiTestResultSchema = z.object({
  ok: z.boolean(),
  provider: AiProviderSchema,
  model: z.string().max(80),
  latencyMs: z.number().int().min(0),
  message: z.string().max(300),
  /** Which chain step supplied the key; null when none did (local rules). */
  source: CredentialSourceSchema.nullable().optional(),
});
export type AiTestResult = z.infer<typeof AiTestResultSchema>;
