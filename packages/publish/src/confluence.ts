/**
 * Confluence Cloud REST client — the small part of the API this app needs.
 *
 * Pages use REST v2 (`/wiki/api/v2/pages`); attachments still only exist in the
 * v1 content API, so they use `/wiki/rest/api/content/:id/child/attachment`.
 * Basic auth with the user's email and a personal API token; the token lives in
 * the request that carries it and is never written to a file.
 */

export interface ConfluenceCredentials {
  /** Site address, e.g. `https://acme.atlassian.net` or `https://acme.atlassian.net/wiki`. */
  baseUrl: string;
  email: string;
  apiToken: string;
}

export interface RemotePage {
  id: string;
  title: string;
  version: number;
  url: string;
}

export interface RemoteAttachment {
  id: string;
  title: string;
  version: number;
}

export interface AttachmentFile {
  fileName: string;
  contentType: string;
  data: Uint8Array;
}

export class ConfluenceError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(message: string, status: number, detail = '') {
    super(message);
    this.name = 'ConfluenceError';
    this.status = status;
    this.detail = detail;
  }
}

export interface ConfluenceClientOptions extends ConfluenceCredentials {
  timeoutMs?: number;
  /** Injected by tests; defaults to the runtime's fetch. */
  fetchImpl?: typeof fetch;
}

interface PageJson {
  id?: string;
  title?: string;
  version?: { number?: number };
  spaceId?: string;
  _links?: { webui?: string };
}

export class ConfluenceClient {
  readonly #origin: string;
  readonly #auth: string;
  readonly #timeout: number;
  readonly #fetch: typeof fetch;

  constructor(options: ConfluenceClientOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl.trim());
    } catch {
      throw new ConfluenceError('Base URL 형식이 올바르지 않습니다. https://사이트.atlassian.net 형식이어야 합니다.', 400);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ConfluenceError('Base URL은 http(s) 주소여야 합니다.', 400);
    }
    this.#origin = url.origin;
    this.#auth = `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString('base64')}`;
    this.#timeout = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get origin(): string {
    return this.#origin;
  }

  /** Accepts a numeric space id or a space key and resolves it to both. */
  async resolveSpace(space: string): Promise<{ id: string; key: string }> {
    const trimmed = space.trim();
    if (trimmed === '') throw new ConfluenceError('Space ID 또는 Key를 입력해 주세요.', 400);
    if (/^\d+$/.test(trimmed)) return { id: trimmed, key: trimmed };

    const response = await this.#json('GET', `/wiki/api/v2/spaces?keys=${encodeURIComponent(trimmed)}&limit=1`);
    const results = (response as { results?: Array<{ id?: string; key?: string }> }).results ?? [];
    const first = results[0];
    if (first?.id === undefined) {
      throw new ConfluenceError(`Confluence 공간 '${trimmed}'을(를) 찾지 못했습니다.`, 404);
    }
    return { id: first.id, key: first.key ?? trimmed };
  }

  async createPage(input: {
    spaceId: string;
    title: string;
    body: string;
    parentId?: string;
  }): Promise<RemotePage> {
    const payload: Record<string, unknown> = {
      spaceId: input.spaceId,
      status: 'current',
      title: input.title,
      body: { representation: 'storage', value: input.body },
    };
    if (input.parentId !== undefined) payload.parentId = input.parentId;
    const json = (await this.#json('POST', '/wiki/api/v2/pages', payload)) as PageJson;
    return this.#page(json, '페이지를 만들지 못했습니다.');
  }

  async getPage(pageId: string): Promise<RemotePage & { spaceId: string | null }> {
    const json = (await this.#json('GET', `/wiki/api/v2/pages/${encodeURIComponent(pageId)}`)) as PageJson;
    return { ...this.#page(json, '페이지를 읽지 못했습니다.'), spaceId: json.spaceId ?? null };
  }

  /**
   * Updates the page body in place. The version is read first so the write is
   * against the current one — Confluence rejects a stale version, which is how
   * a concurrent editor is noticed rather than silently overwritten.
   */
  async updatePage(pageId: string, input: { title: string; body: string }): Promise<RemotePage> {
    const current = await this.getPage(pageId);
    const json = (await this.#json('PUT', `/wiki/api/v2/pages/${encodeURIComponent(pageId)}`, {
      id: pageId,
      status: 'current',
      title: input.title,
      body: { representation: 'storage', value: input.body },
      version: { number: current.version + 1, message: 'spec-studio publish' },
    })) as PageJson;
    return this.#page(json, '페이지를 갱신하지 못했습니다.');
  }

  async listAttachments(pageId: string): Promise<RemoteAttachment[]> {
    const response = (await this.#json(
      'GET',
      `/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/attachment?limit=200`,
    )) as { results?: Array<{ id?: string; title?: string; version?: { number?: number } }> };
    return (response.results ?? [])
      .filter((item): item is { id: string; title: string; version?: { number?: number } } =>
        typeof item.id === 'string' && typeof item.title === 'string',
      )
      .map((item) => ({ id: item.id, title: item.title, version: item.version?.number ?? 1 }));
  }

  /**
   * Uploads one file, updating the existing attachment with the same name when
   * there is one — so re-publishing changes three attachments instead of
   * stacking nine.
   */
  async uploadAttachment(
    pageId: string,
    file: AttachmentFile,
  ): Promise<{ id: string; title: string; action: 'created' | 'updated' }> {
    const existing = (await this.listAttachments(pageId)).find((item) => item.title === file.fileName);
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(file.data)], { type: file.contentType }),
      file.fileName,
    );
    form.append('minorEdit', 'true');

    const path =
      existing === undefined
        ? `/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`
        : `/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/attachment/${encodeURIComponent(
            existing.id,
          )}/data`;

    const response = (await this.#json('POST', path, form, { 'x-atlassian-token': 'no-check' })) as {
      results?: Array<{ id?: string; title?: string }>;
    };
    const first = response.results?.[0];
    if (first?.id === undefined) {
      throw new ConfluenceError(`첨부 '${file.fileName}'을(를) 올리지 못했습니다.`, 502);
    }
    return {
      id: first.id,
      title: first.title ?? file.fileName,
      action: existing === undefined ? 'created' : 'updated',
    };
  }

  #page(json: PageJson, fallback: string): RemotePage {
    if (json.id === undefined) throw new ConfluenceError(fallback, 502);
    const webui = json._links?.webui ?? '';
    const url = webui.startsWith('http')
      ? webui
      : webui === ''
        ? `${this.#origin}/wiki/pages/${json.id}`
        : `${this.#origin}/wiki${webui.startsWith('/') ? '' : '/'}${webui}`;
    return {
      id: json.id,
      title: json.title ?? '',
      version: json.version?.number ?? 1,
      url,
    };
  }

  async #json(
    method: string,
    path: string,
    payload?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: this.#auth,
      accept: 'application/json',
      ...extraHeaders,
    };
    let body: BodyInit | null = null;
    if (payload instanceof FormData) {
      body = payload;
    } else if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(payload);
    }

    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}${path}`, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ConfluenceError(`Confluence에 연결하지 못했습니다. (${reason})`, 0);
    }

    const text = await response.text();
    if (!response.ok) {
      const detail = text.slice(0, 500);
      throw new ConfluenceError(
        `Confluence 응답 ${response.status}${response.status === 401 ? ' — 이메일과 API 토큰을 확인해 주세요' : ''}`,
        response.status,
        detail,
      );
    }
    if (text === '') return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { raw: text };
    }
  }
}
