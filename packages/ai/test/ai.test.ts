import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AiDraftError,
  AiProviderError,
  callModel,
  extractJsonObject,
  parseDocDraft,
  parseGraphDraft,
  probeProvider,
  redact,
  resolveApiKey,
} from '../src/index';

/**
 * The model-facing half has three jobs, and each gets its own test: peel a
 * draft out of whatever the model wrapped it in, hold the draft to the
 * protocol schema, and speak both provider dialects without ever letting the
 * key into a message.
 */

const servers: Server[] = [];

async function fakeProvider(
  handler: (body: unknown, headers: Record<string, string | string[] | undefined>) => {
    status?: number;
    body: unknown;
  },
): Promise<string> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const answer = handler(raw === '' ? {} : JSON.parse(raw), request.headers);
      response.statusCode = answer.status ?? 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(answer.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('extracting the draft', () => {
  it('reads JSON out of fences and prose', () => {
    const text = 'Sure — here you go:\n```json\n{"answer":1}\n```\nThat is all.';
    expect(extractJsonObject(text)).toEqual({ answer: 1 });
  });

  it('reads bare JSON with no fence at all', () => {
    expect(extractJsonObject('{"a":[1,2]}')).toEqual({ a: [1, 2] });
  });

  it('refuses text without JSON', () => {
    expect(() => extractJsonObject('I cannot help with that.')).toThrow(AiDraftError);
  });

  it('accepts a graph draft and keeps its pin numbers', () => {
    const draft = parseGraphDraft(
      JSON.stringify({
        summary: '배송 정책 초안',
        nodes: [{ key: 'n1', type: 'policy', title: '배송 시작 후 취소 불가', body: 'x', pins: [1] }],
        links: [{ type: 'governs', src: 'item:n1', dst: 'pin:1' }],
      }),
    );
    expect(draft.nodes[0]?.pins).toEqual([1]);
    expect(draft.links[0]?.type).toBe('governs');
  });

  it('rejects a node type the graph does not have', () => {
    expect(() =>
      parseGraphDraft(
        JSON.stringify({
          summary: 'x',
          nodes: [{ key: 'n1', type: 'epic', title: '없는 타입', body: '', pins: [] }],
          links: [],
        }),
      ),
    ).toThrow(/스키마/);
  });

  it('rejects an untyped link', () => {
    expect(() =>
      parseGraphDraft(
        JSON.stringify({
          summary: 'x',
          nodes: [{ key: 'n1', type: 'req', title: '요구', body: '', pins: [] }],
          links: [{ type: 'related_to', src: 'item:n1', dst: 'pin:1' }],
        }),
      ),
    ).toThrow(AiDraftError);
  });

  it('rejects a doc patch that is not a block id', () => {
    expect(() =>
      parseDocDraft(
        JSON.stringify({ summary: 'x', patches: [{ blockId: 'first', text: '본문', pins: [] }] }),
      ),
    ).toThrow(AiDraftError);
  });

  it('accepts a doc draft with a real block id', () => {
    const draft = parseDocDraft(
      JSON.stringify({
        summary: '배송 문단을 고친다',
        patches: [{ blockId: 'B_aaaaaaaaaaaa', text: '배송이 시작되면 취소할 수 없다.', pins: [1] }],
      }),
    );
    expect(draft.patches).toHaveLength(1);
  });
});

describe('provider calls', () => {
  it('speaks the Anthropic Messages API and returns the text block', async () => {
    const base = await fakeProvider((body, headers) => {
      const request = body as { model?: string; system?: string; messages?: unknown[] };
      expect(request.model).toBe('claude-sonnet-4-5');
      expect(headers['x-api-key']).toBe('sk-ant-test');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      return { body: { content: [{ type: 'text', text: '{"ok":true}' }] } };
    });

    const result = await callModel({
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5',
      endpoint: base,
      system: 'system',
      prompt: 'prompt',
    });
    expect(result.text).toBe('{"ok":true}');
  });

  it('speaks OpenAI-compatible Chat Completions with a custom base URL', async () => {
    let seenPath = '';
    const base = await fakeProvider((body, headers) => {
      const request = body as { model?: string; messages?: Array<{ role: string }> };
      expect(request.messages?.[0]?.role).toBe('system');
      expect(headers.authorization).toBe('Bearer sk-local');
      return { body: { choices: [{ message: { content: '{"ok":true}' } }] } };
    });
    // `/v1` is part of the base URL a person types; the path is appended to it.
    seenPath = `${base}/v1`;
    const result = await callModel({
      provider: 'openai',
      apiKey: 'sk-local',
      model: 'local-1',
      endpoint: seenPath,
      system: 'system',
      prompt: 'prompt',
    });
    expect(result.text).toBe('{"ok":true}');
    expect(result.model).toBe('local-1');
  });

  it('reports a rejected key without echoing it', async () => {
    const base = await fakeProvider(() => ({
      status: 401,
      body: { error: { message: 'invalid x-api-key: sk-secret-value' } },
    }));
    const failure = await callModel({
      provider: 'anthropic',
      apiKey: 'sk-secret-value',
      model: 'claude',
      endpoint: base,
      system: 's',
      prompt: 'p',
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AiProviderError);
    expect((failure as AiProviderError).code).toBe('auth');
    expect((failure as AiProviderError).message).not.toContain('sk-secret-value');
  });

  it('redacts a key that appears in arbitrary text', () => {
    expect(redact('token=sk-abc here', 'sk-abc')).toBe('token=[redacted] here');
  });

  it('probes an endpoint and reports it usable', async () => {
    const base = await fakeProvider(() => ({
      body: { choices: [{ message: { content: '{"ok":true}' } }] },
    }));
    const probe = await probeProvider({
      provider: 'openai',
      apiKey: 'sk-local',
      model: 'local-1',
      endpoint: base,
    });
    expect(probe.ok).toBe(true);
    expect(probe.message).toContain('연결');
  });
});

describe('resolving the key', () => {
  const env = { ANTHROPIC_API_KEY: 'env-anthropic', OPENAI_API_KEY: 'env-openai' };

  /** A keychain double: a Map plus a call log, nothing else. */
  const keychainWith = (entries: Record<string, string>) => {
    const calls: string[] = [];
    return {
      source: 'keychain' as const,
      calls,
      async resolve(_provider: 'anthropic' | 'openai', presetId: string) {
        calls.push(presetId);
        return entries[presetId] ?? null;
      },
    };
  };

  it('prefers the request key, then the environment, then nothing', async () => {
    await expect(resolveApiKey('anthropic', undefined, 'body-key', env)).resolves.toEqual({
      key: 'body-key',
      source: 'request',
    });
    await expect(resolveApiKey('anthropic', undefined, '', env)).resolves.toEqual({
      key: 'env-anthropic',
      source: 'env',
    });
    await expect(resolveApiKey('openai', undefined, null, {})).resolves.toEqual({
      key: null,
      source: null,
    });
    await expect(resolveApiKey('local', undefined, 'ignored', env)).resolves.toEqual({
      key: null,
      source: null,
    });
  });

  it('reads the keychain between the request key and the environment', async () => {
    const keychain = keychainWith({ openai: 'sk-keychain' });
    // request > keychain
    await expect(
      resolveApiKey('openai', 'openai', 'body-key', env, keychain),
    ).resolves.toEqual({ key: 'body-key', source: 'request' });
    // keychain > env
    await expect(resolveApiKey('openai', 'openai', null, env, keychain)).resolves.toEqual({
      key: 'sk-keychain',
      source: 'keychain',
    });
    // keychain miss → env
    await expect(
      resolveApiKey('openai', 'custom', null, env, keychain),
    ).resolves.toEqual({ key: 'env-openai', source: 'env' });
  });

  it('treats a broken keychain as absent, not as a failure', async () => {
    const broken = {
      source: 'keychain' as const,
      async resolve(): Promise<string | null> {
        throw new Error('safeStorage unavailable');
      },
    };
    await expect(resolveApiKey('openai', 'openai', null, env, broken)).resolves.toEqual({
      key: 'env-openai',
      source: 'env',
    });
    await expect(resolveApiKey('openai', 'openai', null, {}, broken)).resolves.toEqual({
      key: null,
      source: null,
    });
  });
});
