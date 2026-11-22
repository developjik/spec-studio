import { TAVILY_ENV_KEY, WEB_SEARCH_TOOL } from '@spec-studio/protocol';
import { callTavily } from '@spec-studio/ai';
import type { DeclaredTool } from './agent';

/**
 * Tool №1 of web research (E3 F2), the daemon's half: the only process that
 * may touch the network (AC-4). Key resolution is the BYOK chain's env leg —
 * no key means the honest failure the model and the journal both see, never
 * a silent fallback ('웹 검색 불가' 배지의 데이터).
 */
export function webSearchTool(options: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): DeclaredTool {
  const env = options.env ?? {};
  return {
    spec: WEB_SEARCH_TOOL,
    async execute(call) {
      const key = (env[TAVILY_ENV_KEY] ?? '').trim();
      if (key === '') {
        return {
          ok: false,
          output: '웹 검색 불가: TAVILY_API_KEY 키가 없습니다. 키를 설정한 뒤 이 런을 재개하세요.',
        };
      }
      const input = (call.input ?? {}) as { query?: string; url?: string };
      const query = (input.query ?? '').trim();
      if (query === '') {
        return { ok: false, output: '검색 질의(query)가 비어 있습니다.' };
      }
      try {
        const { results } = await callTavily({
          apiKey: key,
          query,
          ...(input.url === undefined || input.url === '' ? {} : { url: input.url }),
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        });
        if (results.length === 0) {
          return { ok: true, output: JSON.stringify({ results: [], note: '검색 결과가 없습니다.' }) };
        }
        return { ok: true, output: JSON.stringify({ results }) };
      } catch (error) {
        return {
          ok: false,
          output: `웹 검색 실패: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`,
        };
      }
    },
  };
}
