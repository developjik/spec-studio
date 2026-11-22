/**
 * Tavily — the web-research provider (E3 F2 · A2 재량 선정). One call serves
 * both halves of "웹 검색+본문 취득": a query hits `/search`, an explicit url
 * hits `/extract`. The daemon is the only caller (AC-4: 외부 fetch는 데몬
 * 경로만) and injects `fetchImpl`, so this module never touches a socket in
 * tests. R6 계약 승계: excerpts stay short — a quote, never a copy.
 */

export interface TavilySearchInput {
  apiKey: string;
  query: string;
  /** When set, fetch this page's body instead of running a search. */
  url?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface TavilyResult {
  title: string;
  url: string;
  /** A short quote from the page — capped at EXCERPT_MAX (R6). */
  excerpt: string;
}

/** R6: the tool hands the model a quote, never the whole page. */
export const EXCERPT_MAX = 700;

const TAVILY_BASE = 'https://api.tavily.com';

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_MAX ? flat : `${flat.slice(0, EXCERPT_MAX - 1)}…`;
}

export async function callTavily(input: TavilySearchInput): Promise<{ results: TavilyResult[] }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const signal = AbortSignal.any([
    AbortSignal.timeout(input.timeoutMs ?? 15_000),
    ...(input.signal === undefined ? [] : [input.signal]),
  ]);
  const extract = input.url !== undefined;
  const response = await fetchImpl(`${TAVILY_BASE}/${extract ? 'extract' : 'search'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${input.apiKey}` },
    body: JSON.stringify(
      extract
        ? { urls: [input.url] }
        : { query: input.query, max_results: 5, search_depth: 'basic' },
    ),
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 160);
    throw new Error(`Tavily ${extract ? 'extract' : 'search'} 실패 (${response.status})${detail === '' ? '' : ` · ${detail}`}`);
  }
  const body = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; raw_content?: string | null }>;
  };
  const results = (body.results ?? [])
    .filter((row): row is { title?: string; url?: string; content?: string; raw_content?: string | null } =>
      typeof row.url === 'string' && row.url !== '',
    )
    .slice(0, 5)
    .map((row) => ({
      title: (row.title ?? row.url ?? '').slice(0, 200),
      url: row.url as string,
      excerpt: clip(row.content ?? row.raw_content ?? ''),
    }));
  return { results };
}
