import { z } from 'zod';
import { BlockIdSchema } from './doc.js';
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

/** A reasonable first model name; the field stays editable on purpose. */
export const AI_DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o-mini',
  local: '',
};

export const AI_DEFAULT_ENDPOINTS: Record<AiRemoteProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
};

export const AI_PROPOSAL_MODES = ['graph', 'doc'] as const;
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
 * A base URL for a provider call. `null` means the provider default. Only
 * http(s) is accepted: `fetch` would otherwise happily take `file:` or `data:`,
 * and an endpoint is not the place to discover that.
 */
export const AiEndpointSchema = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((value) => /^https?:\/\//i.test(value), {
    message: 'endpoint must be an http(s) url',
  });

/**
 * Provider · model · endpoint. These are not secrets, but they are also not
 * written to the database: they live in the window for the session, like the
 * key does.
 */
export const AiSettingsSchema = z.object({
  provider: AiProviderSchema.default('local'),
  model: z.string().trim().max(80).default(''),
  /** A custom base URL (local model server, gateway). `null` uses the default. */
  endpoint: AiEndpointSchema.nullable().default(null),
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
    .regex(/^(item|pin):[A-Za-z0-9_-]{1,24}$/, {
      message: 'a draft ref is item:<key> or pin:<number>',
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

/** What the browser asks the daemon for. The key rides in this body and nowhere else. */
export const AiProposalRequestSchema = z.object({
  mode: AiProposalModeSchema,
  provider: AiProviderSchema.default('local'),
  model: z.string().trim().max(80).default(''),
  endpoint: AiEndpointSchema.nullable().optional(),
  /** Session memory only: the daemon forwards it and keeps no copy. */
  apiKey: z.string().max(400).nullable().optional(),
  /** Which document a `doc` proposal edits; defaults to the project's document. */
  docId: z.string().max(40).optional(),
});
export type AiProposalRequest = z.infer<typeof AiProposalRequestSchema>;

export const AiTestRequestSchema = z.object({
  provider: AiProviderSchema.default('local'),
  model: z.string().trim().max(80).default(''),
  endpoint: AiEndpointSchema.nullable().optional(),
  apiKey: z.string().max(400).nullable().optional(),
});
export type AiTestRequest = z.infer<typeof AiTestRequestSchema>;

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
});
export type AiStatus = z.infer<typeof AiStatusSchema>;

export const AiTestResultSchema = z.object({
  ok: z.boolean(),
  provider: AiProviderSchema,
  model: z.string().max(80),
  latencyMs: z.number().int().min(0),
  message: z.string().max(300),
});
export type AiTestResult = z.infer<typeof AiTestResultSchema>;
