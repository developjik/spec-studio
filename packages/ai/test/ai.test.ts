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
  hasEnvKey,
  isOfficialEndpoint,
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
  it('prefers the request key, then the environment, then nothing', () => {
    const env = { ANTHROPIC_API_KEY: 'env-anthropic', OPENAI_API_KEY: 'env-openai' };
    expect(resolveApiKey('anthropic', 'body-key', env)).toBe('body-key');
    expect(resolveApiKey('anthropic', '', env)).toBe('env-anthropic');
    expect(resolveApiKey('openai', null, {})).toBeNull();
    expect(resolveApiKey('local', 'ignored', env)).toBeNull();
  });

  it('spends an environment key only on the provider\'s own host', () => {
    const env = { ANTHROPIC_API_KEY: 'env-anthropic', OPENAI_API_KEY: 'env-openai' };

    // The default endpoint, the official base URL, or no endpoint at all.
    expect(resolveApiKey('openai', '', env, null)).toBe('env-openai');
    expect(resolveApiKey('openai', '', env, 'https://api.openai.com/v1')).toBe('env-openai');
    expect(resolveApiKey('anthropic', '', env, 'https://api.anthropic.com')).toBe('env-anthropic');

    // Anything else is a host the request chose, and the daemon's key stays home.
    expect(resolveApiKey('openai', '', env, 'https://collect.evil.example/v1')).toBeNull();
    expect(resolveApiKey('openai', '', env, 'http://127.0.0.1:9999/v1')).toBeNull();
    expect(resolveApiKey('openai', '', env, 'https://api.openai.com.evil.example/v1')).toBeNull();

    // A key the request carried is the user's own, and may go where they point it.
    expect(resolveApiKey('openai', 'sk-body', env, 'https://collect.evil.example/v1')).toBe('sk-body');
  });

  it('knows which endpoints are the provider\'s own, and is not fooled by a lookalike', () => {
    expect(isOfficialEndpoint('anthropic', '')).toBe(true);
    expect(isOfficialEndpoint('anthropic', 'https://api.anthropic.com/v1/messages')).toBe(true);
    expect(isOfficialEndpoint('openai', 'https://api.openai.com')).toBe(true);

    expect(isOfficialEndpoint('openai', 'https://api.openai.com.evil.example/v1')).toBe(false);
    expect(isOfficialEndpoint('openai', 'https://api.openai.com@evil.example/v1')).toBe(false);
    expect(isOfficialEndpoint('openai', 'http://api.openai.com/v1')).toBe(false);
    expect(isOfficialEndpoint('anthropic', 'not a url')).toBe(false);
  });

  it('reports whether a provider has an environment key, never the key', () => {
    expect(hasEnvKey('openai', { OPENAI_API_KEY: 'sk-env' })).toBe(true);
    expect(hasEnvKey('openai', { OPENAI_API_KEY: '  ' })).toBe(false);
    expect(hasEnvKey('local', { OPENAI_API_KEY: 'sk-env' })).toBe(false);
  });

  it('will not dial an endpoint that is not http(s)', async () => {
    const attempt = callModel({
      provider: 'openai',
      apiKey: 'sk-body',
      model: 'm',
      endpoint: 'file:///etc/passwd',
      system: 's',
      prompt: 'p',
    });
    await expect(attempt).rejects.toBeInstanceOf(AiProviderError);
    await expect(attempt).rejects.toThrow(/http\(s\)/);
  });
});
