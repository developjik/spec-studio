import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Command, CredentialPort, Screen } from '@spec-studio/protocol';
import { startDaemon, type Daemon } from '../src/server';

/**
 * The AI routes through the daemon's own HTTP API, against a real SQLite file
 * and a model server that answers in the same dialect a vendor would.
 *
 * What is asserted here is the whole promise of the layer:
 *  - the key rides in one request and is in no file afterwards,
 *  - a model draft becomes the *same* decision card a person already decides on,
 *  - `채택` writes it in one transaction and `되돌리기` takes it back,
 *  - a provider failure or a malformed answer is an error, never a half-write,
 *  - with no key at all the rule extractor answers, and the card says so.
 */

const SCREEN: Screen = {
  id: `S_${'e'.repeat(12)}`,
  title: '주문 취소',
  code: 'SCR-210',
  ref: { kind: 'image', value: 'data:image/svg+xml;base64,PHN2Zy8+' },
  viewport: { width: 1200, height: 800 },
  createdAt: '2026-11-19T09:00:00.000Z',
  updatedAt: '2026-11-19T09:00:00.000Z',
};

interface MockLlm {
  url: string;
  /** The next answer the fake model gives, already stringified. */
  status: number;
  requests: Array<{
    path: string;
    body: { model?: string; messages?: unknown[] };
    /** The Bearer header the daemon sent — how each credential source is seen. */
    authorization: string | null;
  }>;
  setReply(reply: () => string): void;
  close(): Promise<void>;
}

async function startMockLlm(): Promise<MockLlm> {
  const state = {
    status: 200,
    reply: (): string =>
      JSON.stringify({
        summary: '배송 정책과 QA 초안',
        nodes: [
          {
            key: 'n1-policy',
            type: 'policy',
            title: '배송 시작 후 취소 불가',
            body: '배송이 시작된 주문은 취소할 수 없고, 고객에게는 사유와 반품 경로를 안내한다.',
            pins: [1],
          },
          {
            key: 'n2-qa',
            type: 'qa',
            title: '배송 시작 후 취소 시도',
            body: '사전조건: 배송 상태가 배송중이다.\n기대 결과: 취소 버튼이 비활성이고 안내 문구가 보인다.\n판정: 통과 / 실패 / 차단',
            pins: [1],
          },
        ],
        links: [
          { type: 'governs', src: 'item:n1-policy', dst: 'pin:1' },
          { type: 'verifies', src: 'item:n2-qa', dst: 'pin:1' },
          { type: 'verifies', src: 'item:n2-qa', dst: 'item:n1-policy' },
        ],
      }),
    requests: [] as Array<{
      path: string;
      body: { model?: string; messages?: unknown[] };
      authorization: string | null;
    }>,
  };

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      state.requests.push({
        path: request.url ?? '',
        body: raw === '' ? {} : (JSON.parse(raw) as { model?: string; messages?: unknown[] }),
        authorization:
          typeof request.headers.authorization === 'string'
            ? request.headers.authorization
            : null,
      });
      response.statusCode = state.status;
      response.setHeader('content-type', 'application/json');
      if (state.status !== 200) {
        response.end(JSON.stringify({ error: { message: 'the fake model is unwell' } }));
        return;
      }
      const content = state.reply();
      if ((request.url ?? '').startsWith('/v1/messages')) {
        response.end(JSON.stringify({ content: [{ type: 'text', text: content }] }));
      } else {
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    get status() {
      return state.status;
    },
    set status(value: number) {
      state.status = value;
    },
    requests: state.requests,
    setReply(value: () => string) {
      state.reply = value;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface AiEnvelope {
  project?: {
    pins: Array<{ id: string; number: number; title: string }>;
    ideas?: Array<{ id: string; title: string; tags: string[]; state: string }>;
    evidence?: Array<{ id: string; title: string; state: string }>;
    docs: Array<{
      id: string;
      kind: string;
      blocks: Array<{ id: string; text: string; pinRefs: Array<{ pinId: string }> }>;
    }>;
    proposals?: Array<{
      id: string;
      docId: string;
      origin: string;
      state: string;
      source?: string | null;
      patches: unknown[];
    }>;
    graph?: { nodes: Array<{ id: string; type: string; title: string }>; links: unknown[] };
    graphProposal?: {
      id: string;
      state: string;
      source: string;
      provider: string | null;
      model: string | null;
      nodes: unknown[];
      links: unknown[];
    } | null;
  };
  source?: string;
  provider?: string;
  model?: string;
  note?: string;
  opSeq?: number;
  status?: {
    providers: Array<{ provider: string; hasEnvKey: boolean }>;
    localAvailable: boolean;
    localServers?: Array<{ id: string; baseUrl: string; reachable: boolean }>;
    keychainAvailable?: boolean;
    presets?: Array<{ id: string; hasKeychainKey: boolean }>;
  };
  result?: { ok: boolean; provider: string; message: string; latencyMs: number; source?: string | null };
  error?: { code: string; message: string };
}

const daemons: Daemon[] = [];
let dir = '';
let dbPath = '';
let llm: Awaited<ReturnType<typeof startMockLlm>>;

async function boot(
  env: Record<string, string | undefined> = {},
  keychain: CredentialPort | null = null,
  aiFetch?: typeof fetch,
): Promise<Daemon> {
  const started = await startDaemon({
    dbPath,
    port: 0,
    now: () => '2026-11-19T09:30:00.000Z',
    env,
    keychain,
    ...(aiFetch === undefined ? {} : { aiFetch }),
  });
  daemons.push(started);
  return started;
}

async function api<T>(
  target: Daemon,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${target.url}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function seedScreen(target: Daemon): Promise<{ projectId: string; pins: Array<{ id: string; number: number }> }> {
  const created = await api<{ project: { id: string } }>(target, '/api/projects', {
    body: { name: '주문 취소' },
  });
  const projectId = created.body.project.id;
  await api(target, `/api/projects/${projectId}/commands`, {
    body: { command: { type: 'screen.attach', screen: SCREEN } },
  });
  const seedPins = [
    { pinType: 'policy', title: '배송 시작 후 취소 불가', body: '사전조건: 배송 시작' },
    { pinType: 'function', title: '취소 요청', body: '배송 준비 중일 때만 활성' },
    { pinType: 'exception', title: '재고 없음 안내', body: '재고 0이면 버튼 비활성' },
  ] as const;
  for (const [index, pin] of seedPins.entries()) {
    await api(target, `/api/projects/${projectId}/commands`, {
      body: {
        command: {
          type: 'pin.create',
          screenId: SCREEN.id,
          pinType: pin.pinType,
          title: pin.title,
          body: pin.body,
          anchor: { x: 0.2 + index * 0.2, y: 0.3 + index * 0.1 },
        } satisfies Command,
      },
    });
  }
  const detail = await api<AiEnvelope>(target, `/api/projects/${projectId}`);
  return {
    projectId,
    pins: (detail.body.project?.pins ?? []).map((pin) => ({ id: pin.id, number: pin.number })),
  };
}

const AI_REQUEST = {
  mode: 'graph' as const,
  provider: 'openai' as const,
  model: 'mock-1',
  apiKey: 'sk-ui-secret-key',
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spec-studio-ai-'));
  dbPath = join(dir, 'graph.db');
  llm = await startMockLlm();
});

afterEach(async () => {
  for (const started of daemons.splice(0)) {
    try {
      await started.close();
    } catch {
      // already closed by the test
    }
  }
  await llm.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the AI routes', () => {
  it('reports which providers have a key, as booleans only', async () => {
    const daemon = await boot({ OPENAI_API_KEY: 'sk-env-secret' });
    const answer = await api<AiEnvelope>(daemon, '/api/ai');
    expect(answer.status).toBe(200);
    const byProvider = Object.fromEntries(
      (answer.body.status?.providers ?? []).map((entry) => [entry.provider, entry.hasEnvKey]),
    );
    expect(byProvider).toEqual({ anthropic: false, openai: true, local: false });
    expect(JSON.stringify(answer.body)).not.toContain('sk-env-secret');
  });

  it('answers a connection probe without touching the project', async () => {
    const daemon = await boot();
    const probe = await api<AiEnvelope>(daemon, '/api/ai/test', {
      body: { provider: 'openai', model: 'mock-1', endpoint: `${llm.url}/v1`, apiKey: 'sk-probe' },
    });
    expect(probe.status).toBe(200);
    expect(probe.body.result?.ok).toBe(true);
    expect(llm.requests[0]?.path).toBe('/v1/chat/completions');
  });

  it('turns a model draft into one card, adopts it, and takes it back', async () => {
    const daemon = await boot();
    const { projectId } = await seedScreen(daemon);

    const proposal = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/ai/proposal`, {
      body: { ...AI_REQUEST, endpoint: `${llm.url}/v1` },
    });
    expect(proposal.status).toBe(200);
    expect(proposal.body.source).toBe('llm');
    expect(proposal.body.provider).toBe('openai');
    expect(proposal.body.model).toBe('mock-1');
    const card = proposal.body.project?.graphProposal;
    expect(card?.state).toBe('open');
    expect(card?.source).toBe('llm');
    expect(card?.provider).toBe('openai');
    expect(card?.nodes).toHaveLength(2);
    expect(card?.links).toHaveLength(3);
    // Nothing was written by the proposal itself.
    expect(proposal.body.project?.graph?.nodes).toHaveLength(0);

    const adopted = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/commands`, {
      body: { command: { type: 'graph.proposal.adopt', proposalId: card?.id } },
    });
    expect(adopted.status).toBe(200);
    expect(adopted.body.project?.graph?.nodes).toHaveLength(2);
    expect(adopted.body.project?.graph?.links).toHaveLength(3);

    const reverted = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/revert`, {
      body: {},
    });
    expect(reverted.status).toBe(200);
    expect(reverted.body.project?.graph?.nodes).toHaveLength(0);
    expect(reverted.body.project?.graph?.links).toHaveLength(0);
  });

  it('falls back to the rule extractor when no key exists, and says so', async () => {
    const daemon = await boot({});
    const { projectId } = await seedScreen(daemon);
    const proposal = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/ai/proposal`, {
      body: { mode: 'graph', provider: 'anthropic', model: '', apiKey: '' },
    });
    expect(proposal.status).toBe(200);
    expect(proposal.body.source).toBe('rule');
    expect(proposal.body.note).toContain('로컬 규칙');
    expect(proposal.body.project?.graphProposal?.source).toBe('rule');
    expect((proposal.body.project?.graphProposal?.nodes ?? []).length).toBeGreaterThan(0);
    expect(llm.requests).toHaveLength(0);
  });

  it('uses the daemon environment key when the panel leaves the field empty', async () => {
    const daemon = await boot({ OPENAI_API_KEY: 'sk-env-secret' });
    const { projectId } = await seedScreen(daemon);
    const proposal = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/ai/proposal`, {
      body: { mode: 'graph', provider: 'openai', model: 'mock-1', endpoint: `${llm.url}/v1` },
    });
    expect(proposal.status).toBe(200);
    expect(proposal.body.source).toBe('llm');
  });

  it('refuses an answer that is not a draft, without writing anything', async () => {
    const daemon = await boot();
    const { projectId } = await seedScreen(daemon);
    llm.setReply(() => 'I think the policy is fine.');
    const proposal = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/ai/proposal`, {
      body: { ...AI_REQUEST, endpoint: `${llm.url}/v1` },
    });
    expect(proposal.status).toBe(422);
    expect(proposal.body.error?.code).toBe('ai_draft_invalid');
    const detail = await api<AiEnvelope>(daemon, `/api/projects/${projectId}`);
    expect(detail.body.project?.graphProposal).toBeNull();
  });

  it('reports a provider failure as a 502 and keeps the key out of the message', async () => {
    const daemon = await boot();
    const { projectId } = await seedScreen(daemon);
    llm.status = 500;
    const proposal = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/ai/proposal`, {
      body: { ...AI_REQUEST, endpoint: `${llm.url}/v1` },
    });
    expect(proposal.status).toBe(502);
    expect(proposal.body.error?.code).toBe('ai_http_error');
    expect(JSON.stringify(proposal.body)).not.toContain('sk-ui-secret-key');
  });

  it('never writes the key to the SQLite file', async () => {
    const daemon = await boot();
    const { projectId } = await seedScreen(daemon);
    await api(daemon, `/api/projects/${projectId}/ai/proposal`, {
      body: { ...AI_REQUEST, endpoint: `${llm.url}/v1` },
    });
    const bytes = readFileSync(dbPath);
    expect(bytes.includes(Buffer.from('sk-ui-secret-key'))).toBe(false);
    expect(bytes.includes(Buffer.from('mock-1'))).toBe(false);
  });

  it('drafts a paragraph patch and reverts it to the exact previous text', async () => {
    const daemon = await boot();
    const { projectId, pins } = await seedScreen(daemon);
    const seeded = await api<AiEnvelope>(daemon, `/api/projects/${projectId}`);
    const docId = seeded.body.project?.docs[0]?.id ?? '';
    expect(docId).not.toBe('');
    await api(daemon, `/api/projects/${projectId}/commands`, {
      body: {
        command: {
          type: 'doc.block.create',
          docId,
          blockType: 'paragraph',
          text: '취소는 언제든 가능하다.',
        },
      },
    });
    const withDoc = await api<AiEnvelope>(daemon, `/api/projects/${projectId}`);
    const block = withDoc.body.project?.docs[0]?.blocks[0];
    expect(block).toBeDefined();

    llm.setReply(() =>
      JSON.stringify({
        summary: '배송 정책과 문단을 맞춘다',
        patches: [
          {
            blockId: block?.id,
            text: '배송이 시작되기 전까지만 취소할 수 있다.',
            pins: [pins[0]?.number ?? 1],
          },
        ],
      }),
    );
    const proposal = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/ai/proposal`, {
      body: { mode: 'doc', provider: 'openai', model: 'mock-1', endpoint: `${llm.url}/v1`, apiKey: 'sk-doc' },
    });
    expect(proposal.status).toBe(200);
    expect(proposal.body.project?.proposals?.[0]?.origin).toBe('doc-chat');

    const adopted = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/commands`, {
      body: {
        command: {
          type: 'proposal.adopt',
          docId,
          proposalId: proposal.body.project?.proposals?.[0]?.id,
        },
      },
    });
    expect(adopted.status).toBe(200);
    expect(adopted.body.project?.docs[0]?.blocks[0]?.text).toContain('배송이 시작되기 전까지만');

    const reverted = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/revert`, { body: {} });
    expect(reverted.status).toBe(200);
    expect(reverted.body.project?.docs[0]?.blocks[0]?.text).toBe('취소는 언제든 가능하다.');
  });

  it('targets the doc the request names, and defaults to the spec doc', async () => {
    const daemon = await boot();
    const { projectId, pins } = await seedScreen(daemon);
    const seeded = await api<AiEnvelope>(daemon, `/api/projects/${projectId}`);
    const specDocId = seeded.body.project?.docs[0]?.id ?? '';
    const research = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/commands`, {
      body: {
        command: { type: 'doc.create', title: '리서치 노트', kind: 'research' },
      },
    });
    const researchDocId = research.body.project?.docs[1]?.id ?? '';
    expect(researchDocId).not.toBe('');

    const blocks: Record<string, string> = {};
    for (const [label, docId] of [
      ['spec', specDocId],
      ['research', researchDocId],
    ] as const) {
      const added = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/commands`, {
        body: {
          command: {
            type: 'doc.block.create',
            docId,
            blockType: 'paragraph',
            text: label === 'spec' ? '취소는 언제든 가능하다.' : '경쟁 서비스는 취소가 하루만 가능했다.',
          },
        },
      });
      blocks[label] = added.body.project?.docs.find((doc) => doc.id === docId)?.blocks[0]?.id ?? '';
    }

    llm.setReply(() =>
      JSON.stringify({
        summary: '지정한 문서의 문단을 고친다',
        patches: [
          { blockId: blocks.research, text: '경쟁 서비스는 취소가 이틀까지 가능했다.', pins: [pins[0]?.number ?? 1] },
        ],
      }),
    );
    const targeted = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/ai/proposal`, {
      body: {
        mode: 'doc',
        docId: researchDocId,
        provider: 'openai',
        model: 'mock-1',
        endpoint: `${llm.url}/v1`,
        apiKey: 'sk-doc',
      },
    });
    expect(targeted.status).toBe(200);
    const prompt = JSON.stringify(llm.requests.at(-1)?.body.messages ?? []);
    expect(prompt).toContain(blocks.research);
    expect(prompt).not.toContain(blocks.spec);
    expect(prompt).toContain('리서치 노트');
    expect(targeted.body.project?.proposals?.[0]?.docId).toBe(researchDocId);

    // no docId → the first spec doc, not the newest doc. The research
    // proposal leaves the table first, and the model now patches the spec.
    await api(daemon, `/api/projects/${projectId}/commands`, {
      body: {
        command: {
          type: 'proposal.reject',
          docId: researchDocId,
          proposalId: targeted.body.project?.proposals?.[0]?.id,
        },
      },
    });
    llm.setReply(() =>
      JSON.stringify({
        summary: '스펙 문서의 문단을 고친다',
        patches: [
          { blockId: blocks.spec, text: '취소는 배송 준비 중에만 가능하다.', pins: [pins[0]?.number ?? 1] },
        ],
      }),
    );
    const defaulted = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/ai/proposal`, {
      body: {
        mode: 'doc',
        provider: 'openai',
        model: 'mock-1',
        endpoint: `${llm.url}/v1`,
        apiKey: 'sk-doc',
      },
    });
    expect(defaulted.status).toBe(200);
    const defaultPrompt = JSON.stringify(llm.requests.at(-1)?.body.messages ?? []);
    expect(defaultPrompt).toContain(blocks.spec);
    expect(defaultPrompt).not.toContain(blocks.research);
  });

  it('builds a brief from real evidence with the rule fallback, and adopts it', async () => {
    const daemon = await boot();
    const { projectId } = await seedScreen(daemon);
    await api(daemon, `/api/projects/${projectId}/commands`, {
      body: { command: { type: 'doc.create', title: '취소 리서치', kind: 'research' } },
    });
    const idea = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/commands`, {
      body: { command: { type: 'idea.capture', text: '주문 취소 UX 개선\n경쟁 정책을 조사한다.' } },
    });
    const ideaId = idea.body.project?.ideas?.[0]?.id ?? '';
    const titles = ['경쟁사 A 취소 정책', '취소 사유 통계'];
    const evidenceIds: string[] = [];
    for (const [index, title] of titles.entries()) {
      const captured = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/commands`, {
        body: {
          command: {
            type: 'evidence.capture',
            url: `https://example.com/e/${index}`,
            title,
            excerpt: '결제 후 24시간 이내 무료 취소',
            evidenceType: 'web',
          },
        },
      });
      evidenceIds.push(captured.body.project?.evidence?.[index]?.id ?? '');
    }

    const proposal = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/ai/proposal`, {
      body: { mode: 'brief', provider: 'local', ideaId, evidenceIds },
    });
    expect(proposal.status).toBe(200);
    expect(proposal.body.source).toBe('rule');
    expect(proposal.body.note).toContain('로컬 규칙');
    const research = proposal.body.project?.docs.find((doc) => doc.kind === 'research');
    expect(research?.id).toBeDefined();
    const card = proposal.body.project?.proposals?.[0];
    expect(card?.state).toBe('open');

    const adopted = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/commands`, {
      body: { command: { type: 'proposal.adopt', docId: research?.id, proposalId: card?.id } },
    });
    const blocks = adopted.body.project?.docs.find((doc) => doc.kind === 'research')?.blocks ?? [];
    expect(blocks.map((block) => block.text)).toEqual([
      '주문 취소 UX 개선',
      '주문 취소 UX 개선',
      `경쟁사 A 취소 정책 (출처: ${titles[0]})`,
      `취소 사유 통계 (출처: ${titles[1]})`,
      '기회: 주문 취소 UX 개선에서 증거 없이 가정한 기회이다. (근거 없음)',
      '다음 질문: 주문 취소 UX 개선에서 다음에 확인해야 할 질문이다. (근거 없음)',
    ]);
    // only the two seeded titles are ever cited — no invented sources
    const cited = blocks.filter((block) => block.text.includes('(출처:'));
    expect(cited.every((block) => titles.some((title) => block.text.includes(title)))).toBe(true);
  });

  it('P3-2: washes invented source urls out of a single-shot LLM brief (일관 적용)', async () => {
    const daemon = await boot();
    const { projectId } = await seedScreen(daemon);
    await api(daemon, `/api/projects/${projectId}/commands`, {
      body: { command: { type: 'doc.create', title: '취소 리서치', kind: 'research' } },
    });
    const idea = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/commands`, {
      body: { command: { type: 'idea.capture', text: '주문 취소 UX 개선\n경쟁 정책을 조사한다.' } },
    });
    const ideaId = idea.body.project?.ideas?.[0]?.id ?? '';
    const captured = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/commands`, {
      body: {
        command: {
          type: 'evidence.capture',
          url: 'https://example.com/e/real',
          title: '경쟁사 A 취소 정책',
          excerpt: '결제 후 24시간 이내 무료 취소',
          evidenceType: 'web',
        },
      },
    });
    const evidenceId = captured.body.project?.evidence?.[0]?.id ?? '';
    expect(evidenceId).not.toBe('');

    // the model leans on the project's own evidence (honest) and also cites a
    // web url no tool ever returned — AC-3's enemy, now washed on this path too.
    llm.setReply(() =>
      JSON.stringify({
        title: '취소 정책 브리프',
        summary: '취소 정책 브리프',
        claims: [
          {
            text: '경쟁사 A는 24시간 이내 무료 취소를 허용한다',
            evidenceRefs: [evidenceId],
            sourceUrls: ['https://example.com/e/real'],
          },
          { text: '업계 평균 환불율은 31%다', evidenceRefs: [], sourceUrls: ['https://made-up.example/refund'] },
        ],
      }),
    );
    const proposal = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/ai/proposal`, {
      body: {
        mode: 'brief',
        provider: 'openai',
        model: 'mock-1',
        apiKey: 'sk-ui-secret-key',
        endpoint: `${llm.url}/v1`,
        ideaId,
        evidenceIds: [evidenceId],
      },
    });
    expect(proposal.status).toBe(200);
    expect(proposal.body.source).toBe('llm');
    expect(proposal.body.note).toContain('세척');

    // the card's own text is the honest surface: the evidence citation stays,
    // the invented url never lands, and the unsupported claim says so.
    const research = proposal.body.project?.docs.find((doc) => doc.kind === 'research');
    const card = proposal.body.project?.proposals?.find((row) => row.docId === research?.id);
    expect(card).toBeDefined();
    const texts = JSON.stringify(card?.patches ?? []);
    expect(texts).toContain('경쟁사 A 취소 정책'); // evidenceRefs survive untouched
    expect(texts).not.toContain('made-up.example'); // the invented url is gone
    expect(texts).toContain('근거 없음'); // the washed claim says it honestly
  });

  it('refuses a brief when the project has no research document', async () => {
    const daemon = await boot();
    const { projectId } = await seedScreen(daemon);
    const proposal = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/ai/proposal`, {
      body: { mode: 'brief', provider: 'local' },
    });
    expect(proposal.status).toBe(400);
    expect(proposal.body.error?.code).toBe('doc_missing');
    expect(proposal.body.error?.message).toContain('리서치 문서를 먼저 만들어 주세요');
    expect(llm.requests).toHaveLength(0);
  });
});

/**
 * E4 F3-②: the status route's local-runtime probe — which keyless presets are
 * actually listening, aimed only at their own loopback baseUrls. `aiFetch`
 * stands in for the wire so both directions are deterministic.
 */
describe('the local runtime probe (E4 F3)', () => {
  it('reports a reachable local server and an absent one, loopback only', async () => {
    const probed: string[] = [];
    const aiFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      probed.push(url);
      if (url === 'http://localhost:11434/v1/models') {
        return new Response('{"object":"list","data":[]}', { status: 200 });
      }
      throw new Error('connection refused');
    }) as typeof fetch;
    const daemon = await boot({}, null, aiFetch);
    const answer = await api<AiEnvelope>(daemon, '/api/ai');
    expect(answer.status).toBe(200);
    expect(answer.body.status?.localServers).toEqual([
      { id: 'ollama', baseUrl: 'http://localhost:11434/v1', reachable: true },
      { id: 'lmstudio', baseUrl: 'http://localhost:1234/v1', reachable: false },
    ]);
    // The probe only ever aimed at the presets' own loopback URLs.
    expect(probed.sort()).toEqual([
      'http://localhost:11434/v1/models',
      'http://localhost:1234/v1/models',
    ]);
  });

  it('answers silent false when nothing listens — never an error', async () => {
    const aiFetch = (async () => {
      throw new Error('connection refused');
    }) as typeof fetch;
    const daemon = await boot({}, null, aiFetch);
    const answer = await api<AiEnvelope>(daemon, '/api/ai');
    expect(answer.status).toBe(200);
    expect(
      answer.body.status?.localServers?.every((entry) => entry.reachable === false),
    ).toBe(true);
    // Rule fallback availability is unrelated to runtime detection — still true.
    expect(answer.body.status?.localAvailable).toBe(true);
  });
});

/**
 * E4 F3-③: the card's llm/rule provenance persists — a reload reads the same
 * answer the session heard, instead of guessing 'llm' from a doc-chat origin.
 */
describe('proposal source persistence (E4 F3)', () => {
  it('keeps a rule brief and an llm patch honest across a daemon restart', async () => {
    const daemon = await boot();
    const { projectId, pins } = await seedScreen(daemon);
    const seeded = await api<AiEnvelope>(daemon, `/api/projects/${projectId}`);
    const specDocId = seeded.body.project?.docs[0]?.id ?? '';
    const research = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/commands`, {
      body: { command: { type: 'doc.create', title: '취소 리서치', kind: 'research' } },
    });
    const researchDocId = research.body.project?.docs.at(-1)?.id ?? '';
    await api(daemon, `/api/projects/${projectId}/commands`, {
      body: {
        command: {
          type: 'doc.block.create',
          docId: specDocId,
          blockType: 'paragraph',
          text: '취소는 언제든 가능하다.',
        },
      },
    });
    const withDoc = await api<AiEnvelope>(daemon, `/api/projects/${projectId}`);
    const specBlock = withDoc.body.project?.docs.find((doc) => doc.id === specDocId)?.blocks[0];

    // The previously-dishonest cell: a rule-built brief (doc-chat origin)…
    const brief = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/ai/proposal`, {
      body: { mode: 'brief', provider: 'local', topic: '주문 취소 UX 개선' },
    });
    expect(brief.status).toBe(200);
    expect(brief.body.source).toBe('rule');
    expect(brief.body.project?.proposals?.[0]?.origin).toBe('doc-chat');

    // …and a model-made patch.
    llm.setReply(() =>
      JSON.stringify({
        summary: '문단을 맞춘다',
        patches: [
          { blockId: specBlock?.id, text: '배송 준비 중에만 취소 가능하다.', pins: [pins[0]?.number ?? 1] },
        ],
      }),
    );
    const patch = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/ai/proposal`, {
      body: { mode: 'doc', provider: 'openai', model: 'mock-1', endpoint: `${llm.url}/v1`, apiKey: 'sk-doc' },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.source).toBe('llm');

    // A restart: the answers are read back from rows, not session memory.
    await daemon.close();
    const second = await boot();
    const detail = await api<AiEnvelope>(second, `/api/projects/${projectId}`);
    const byDoc = new Map(
      (detail.body.project?.proposals ?? []).map((row) => [row.docId, row.source]),
    );
    expect(byDoc.get(specDocId)).toBe('llm');
    expect(byDoc.get(researchDocId)).toBe('rule');
  });
});

/**
 * The credential chain end to end (F1): request key → keychain → env → local
 * rules. The keychain itself is a double — Electron's safeStorage lives in the
 * desktop shell — but everything around it is the real HTTP API.
 */
describe('the credential chain', () => {
  /** An in-memory port: what the tests use for ordering and status. */
  const memoryKeychain = (entries: Record<string, string> = {}): CredentialPort => {
    const map = new Map(Object.entries(entries));
    return {
      source: 'keychain',
      async resolve(_provider, presetId) {
        return map.get(presetId) ?? null;
      },
      async store(_provider, presetId, key) {
        map.set(presetId, key);
      },
      async erase(_provider, presetId) {
        map.delete(presetId);
      },
    };
  };

  /**
   * A file-backed port mimicking safeStorage's contract: the disk holds
   * ciphertext (base64 stands in for the encrypted blob), never the key
   * string — so "restart" is just a new instance over the same file.
   */
  const fileKeychain = (file: string): CredentialPort => {
    const read = (): Record<string, string> =>
      existsSync(file)
        ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>)
        : {};
    const write = (entries: Record<string, string>) =>
      writeFileSync(file, JSON.stringify(entries), 'utf8');
    return {
      source: 'keychain',
      async resolve(_provider, presetId) {
        const encoded = read()[presetId];
        return encoded === undefined ? null : Buffer.from(encoded, 'base64').toString('utf8');
      },
      async store(_provider, presetId, key) {
        const entries = read();
        entries[presetId] = Buffer.from(key, 'utf8').toString('base64');
        write(entries);
      },
      async erase(_provider, presetId) {
        const entries = read();
        delete entries[presetId];
        write(entries);
      },
    };
  };

  it('answers proposals with the keychain key when the request carries none', async () => {
    const daemon = await boot({}, memoryKeychain({ openai: 'sk-keychain-secret' }));
    const { projectId } = await seedScreen(daemon);
    const proposal = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/ai/proposal`, {
      body: { mode: 'graph', provider: 'openai', presetId: 'openai', model: 'mock-1', endpoint: `${llm.url}/v1` },
    });
    expect(proposal.status).toBe(200);
    expect(proposal.body.source).toBe('llm');
    expect(llm.requests.at(-1)?.authorization).toBe('Bearer sk-keychain-secret');
  });

  it('prefers a request key over the keychain, and env over nothing', async () => {
    const keychain = memoryKeychain({ openai: 'sk-keychain-secret' });
    const daemon = await boot({}, keychain);
    const { projectId } = await seedScreen(daemon);
    const proposal = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/ai/proposal`, {
      body: {
        mode: 'graph',
        provider: 'openai',
        presetId: 'openai',
        model: 'mock-1',
        endpoint: `${llm.url}/v1`,
        apiKey: 'sk-request-wins',
      },
    });
    expect(proposal.status).toBe(200);
    expect(llm.requests.at(-1)?.authorization).toBe('Bearer sk-request-wins');
  });

  it('stores, reports as a boolean only, and erases', async () => {
    const daemon = await boot({}, memoryKeychain());
    const stored = await api<AiEnvelope>(daemon, '/api/ai/keychain/store', {
      body: { presetId: 'openai', apiKey: 'sk-store-me' },
    });
    expect(stored.status).toBe(200);

    const status = await api<AiEnvelope>(daemon, '/api/ai');
    expect(status.body.status?.keychainAvailable).toBe(true);
    const byPreset = Object.fromEntries(
      (status.body.status?.presets ?? []).map((p) => [p.id, p.hasKeychainKey]),
    );
    expect(byPreset['openai']).toBe(true);
    expect(byPreset['anthropic']).toBe(false);
    // Write-only: nothing in the status answer is the key or shaped like it.
    expect(JSON.stringify(status.body)).not.toContain('sk-store-me');

    const erased = await api<AiEnvelope>(daemon, '/api/ai/keychain/erase', {
      body: { presetId: 'openai' },
    });
    expect(erased.status).toBe(200);
    const after = await api<AiEnvelope>(daemon, '/api/ai');
    expect(
      after.body.status?.presets?.find((p) => p.id === 'openai')?.hasKeychainKey,
    ).toBe(false);
  });

  it('reports keychain_unavailable where there is no port (web mode)', async () => {
    const daemon = await boot({}, null);
    const status = await api<AiEnvelope>(daemon, '/api/ai');
    expect(status.body.status?.keychainAvailable).toBe(false);
    const stored = await api<AiEnvelope>(daemon, '/api/ai/keychain/store', {
      body: { presetId: 'openai', apiKey: 'sk-nowhere' },
    });
    expect(stored.status).toBe(501);
    expect(stored.body.error?.code).toBe('keychain_unavailable');
  });

  it('rejects a store for an unknown preset', async () => {
    const daemon = await boot({}, memoryKeychain());
    const stored = await api<AiEnvelope>(daemon, '/api/ai/keychain/store', {
      body: { presetId: 'not-a-preset', apiKey: 'sk-x' },
    });
    expect(stored.status).toBe(404);
    expect(stored.body.error?.code).toBe('preset_unknown');
  });

  it('calls a keyless local-server preset without a key (authMode none)', async () => {
    const daemon = await boot();
    const { projectId } = await seedScreen(daemon);
    const proposal = await api<AiEnvelope>(daemon, `/api/projects/${projectId}/ai/proposal`, {
      body: {
        mode: 'graph',
        provider: 'openai',
        presetId: 'ollama',
        model: 'mock-1',
        endpoint: `${llm.url}/v1`,
      },
    });
    expect(proposal.status).toBe(200);
    expect(proposal.body.source).toBe('llm');
    // fetch normalises `Bearer ` (empty token) to a bare `Bearer` on the wire.
    expect(llm.requests.at(-1)?.authorization).toBe('Bearer');
  });

  it('AC-6: a stored key survives a restart and is nowhere on disk as a string', async () => {
    const sentinel = 'sk-keychain-W2-SENTINEL-7f3a';
    const keychainFile = join(dir, 'keychain.json');

    // First boot: store the key and use it once.
    const first = await boot({}, fileKeychain(keychainFile));
    const { projectId } = await seedScreen(first);
    const saved = await api<AiEnvelope>(first, '/api/ai/keychain/store', {
      body: { presetId: 'openai', apiKey: sentinel },
    });
    expect(saved.status).toBe(200);
    const proposal = await api<AiEnvelope>(first, `/api/projects/${projectId}/ai/proposal`, {
      body: { mode: 'graph', provider: 'openai', presetId: 'openai', model: 'mock-1', endpoint: `${llm.url}/v1` },
    });
    expect(proposal.body.source).toBe('llm');
    expect(llm.requests.at(-1)?.authorization).toBe(`Bearer ${sentinel}`);

    // "Restart": a new daemon, a new port instance, same backing file.
    await first.close();
    const second = await boot({}, fileKeychain(keychainFile));
    const restored = await api<AiEnvelope>(second, `/api/projects/${projectId}/ai/proposal`, {
      body: { mode: 'graph', provider: 'openai', presetId: 'openai', model: 'mock-1', endpoint: `${llm.url}/v1` },
    });
    expect(restored.status).toBe(200);
    expect(restored.body.source).toBe('llm');
    expect(llm.requests.at(-1)?.authorization).toBe(`Bearer ${sentinel}`);

    // The sentinel is in no persisted surface — AC-6's grep check.
    const db = readFileSync(dbPath); // SQLite
    expect(db.includes(Buffer.from(sentinel))).toBe(false);
    const bundle = await api<AiEnvelope>(second, `/api/projects/${projectId}/export`); // 번들
    expect(JSON.stringify(bundle.body)).not.toContain(sentinel);
    const backing = readFileSync(keychainFile); // keychain backing file: ciphertext only
    expect(backing.includes(Buffer.from(sentinel))).toBe(false);
    const status = await api<AiEnvelope>(second, '/api/ai'); // status answers booleans
    expect(JSON.stringify(status.body)).not.toContain(sentinel);
  });
});
