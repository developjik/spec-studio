import { describe, expect, it } from 'vitest';
import { callTavily, EXCERPT_MAX } from '../src/web';

/** E3 F2: the Tavily client is a pure port — fetch arrives injected. */

function tavilyFetch(results: Array<{ title?: string; url?: string; content?: string }>): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ results }), { status: 200 })) as unknown as typeof fetch;
}

describe('callTavily — search', () => {
  it('returns title·url·excerpt rows', async () => {
    const { results } = await callTavily({
      apiKey: 'tvly-test',
      query: '경쟁 브리프',
      fetchImpl: tavilyFetch([
        { title: '경쟁사 동향', url: 'https://example.com/rivals', content: '요약 내용' },
      ]),
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ title: '경쟁사 동향', url: 'https://example.com/rivals', excerpt: '요약 내용' });
  });

  it('flattens and clips the excerpt to R6’s quote ceiling', async () => {
    const long = 'x'.repeat(EXCERPT_MAX + 500);
    const { results } = await callTavily({
      apiKey: 'tvly-test',
      query: 'q',
      fetchImpl: tavilyFetch([{ url: 'https://example.com/a', content: `${long}\n\n   more` }]),
    });
    expect(results[0]!.excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(results[0]!.excerpt.endsWith('…')).toBe(true);
  });

  it('rows without a url are dropped; five at most survive', async () => {
    const rows = [
      { title: 'ok', url: 'https://example.com/1', content: 'a' },
      { title: 'no url', content: 'b' },
      ...Array.from({ length: 6 }, (_, i) => ({ url: `https://example.com/${i + 2}` })),
    ];
    const { results } = await callTavily({
      apiKey: 'tvly-test',
      query: 'q',
      fetchImpl: tavilyFetch(rows),
    });
    expect(results).toHaveLength(5);
    expect(results.every((row) => row.url.startsWith('https://'))).toBe(true);
  });

  it('a non-2xx answer is an honest error, status included', async () => {
    const failing = (async () => new Response('{"detail":"bad key"}', { status: 401 })) as unknown as typeof fetch;
    await expect(
      callTavily({ apiKey: 'tvly-bad', query: 'q', fetchImpl: failing }),
    ).rejects.toThrow(/Tavily search 실패 \(401\)/);
  });

  it('an explicit url goes to extract, not search', async () => {
    let seen: { url: string; body: unknown } | undefined;
    const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ results: [{ url: 'https://example.com/x', raw_content: '본문' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const { results } = await callTavily({
      apiKey: 'tvly-test',
      query: 'anything',
      url: 'https://example.com/x',
      fetchImpl: spy,
    });
    expect(seen!.url).toContain('/extract');
    expect((seen!.body as { urls: string[] }).urls).toEqual(['https://example.com/x']);
    expect(results[0]).toMatchObject({ url: 'https://example.com/x', excerpt: '본문' });
  });
});
