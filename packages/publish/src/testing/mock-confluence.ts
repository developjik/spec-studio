import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Buffer } from 'node:buffer';

/**
 * A Confluence-shaped server for tests: v2 pages, v1 attachments, Basic auth.
 * It keeps enough state that a second publish can be checked against the first
 * — page count, version, and the attachments that actually arrived.
 */

export interface MockPage {
  id: string;
  title: string;
  body: string;
  version: number;
  spaceId: string;
}

export interface MockAttachment {
  id: string;
  title: string;
  contentType: string;
  bytes: number;
  version: number;
}

export interface MockRequest {
  method: string;
  path: string;
  authorized: boolean;
}

export interface MockConfluence {
  url: string;
  port: number;
  pages: Map<string, MockPage>;
  attachments: Map<string, MockAttachment[]>;
  requests: MockRequest[];
  pageCreates: number;
  pageUpdates: number;
  attachmentUploads: number;
  close(): Promise<void>;
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(payload);
}

function read(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Minimal multipart reader: enough for one `file` part. Confluence itself does
 * the real parsing; this only has to prove the bytes left the client.
 */
export function parseMultipart(
  contentType: string,
  body: Buffer,
): Array<{ name: string; fileName: string | null; type: string; data: Buffer }> {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (boundary === undefined) return [];
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Array<{ name: string; fileName: string | null; type: string; data: Buffer }> = [];
  let index = body.indexOf(delimiter);
  while (index >= 0) {
    const next = body.indexOf(delimiter, index + delimiter.length);
    if (next < 0) break;
    const chunk = body.subarray(index + delimiter.length + 2, next - 2);
    const headerEnd = chunk.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      const headers = chunk.subarray(0, headerEnd).toString('utf8');
      const data = chunk.subarray(headerEnd + 4);
      const name = /name="([^"]*)"/i.exec(headers)?.[1] ?? '';
      const fileName = /filename="([^"]*)"/i.exec(headers)?.[1] ?? null;
      const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? 'application/octet-stream';
      parts.push({ name, fileName, type, data });
    }
    index = next;
  }
  return parts;
}

export async function startMockConfluence(options: { spaceId?: string; spaceKey?: string } = {}): Promise<MockConfluence> {
  const spaceId = options.spaceId ?? '12345';
  const spaceKey = options.spaceKey ?? 'SPEC';
  let pageSeq = 100;
  let attachmentSeq = 900;

  const pages = new Map<string, MockPage>();
  const attachments = new Map<string, MockAttachment[]>();
  const requests: MockRequest[] = [];

  const mock: MockConfluence = {
    url: '',
    port: 0,
    pages,
    attachments,
    requests,
    pageCreates: 0,
    pageUpdates: 0,
    attachmentUploads: 0,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const authorized = (req.headers.authorization ?? '').startsWith('Basic ');
      requests.push({ method: req.method ?? 'GET', path: `${path}${url.search}`, authorized });
      const body = await read(req);

      if (req.method === 'GET' && path === '/__state') {
        return json(res, 200, {
          pageCreates: mock.pageCreates,
          pageUpdates: mock.pageUpdates,
          attachmentUploads: mock.attachmentUploads,
          pages: [...pages.values()].map((page) => ({
            id: page.id,
            title: page.title,
            version: page.version,
            attachments: (attachments.get(page.id) ?? []).map((item) => ({
              title: item.title,
              bytes: item.bytes,
              version: item.version,
            })),
          })),
        });
      }

      if (req.method === 'GET' && path === '/wiki/api/v2/spaces') {
        const keys = url.searchParams.get('keys') ?? '';
        if (keys.toUpperCase() !== spaceKey.toUpperCase()) return json(res, 200, { results: [] });
        return json(res, 200, { results: [{ id: spaceId, key: spaceKey }] });
      }

      if (req.method === 'POST' && path === '/wiki/api/v2/pages') {
        const payload = JSON.parse(body.toString('utf8')) as {
          spaceId?: string;
          title?: string;
          body?: { value?: string };
        };
        pageSeq += 1;
        const id = String(pageSeq);
        const page: MockPage = {
          id,
          title: payload.title ?? '',
          body: payload.body?.value ?? '',
          version: 1,
          spaceId: payload.spaceId ?? '',
        };
        pages.set(id, page);
        attachments.set(id, []);
        mock.pageCreates += 1;
        return json(res, 200, {
          id,
          title: page.title,
          version: { number: 1 },
          _links: { webui: `/spaces/${spaceKey}/pages/${id}/${encodeURIComponent(page.title)}` },
        });
      }

      const pageMatch = /^\/wiki\/api\/v2\/pages\/([^/]+)$/.exec(path);
      if (pageMatch !== null) {
        const id = decodeURIComponent(pageMatch[1] as string);
        const page = pages.get(id);
        if (page === undefined) return json(res, 404, { message: 'not found' });
        if (req.method === 'GET') {
          return json(res, 200, {
            id,
            title: page.title,
            version: { number: page.version },
            spaceId: page.spaceId,
            _links: { webui: `/spaces/${spaceKey}/pages/${id}/${encodeURIComponent(page.title)}` },
          });
        }
        if (req.method === 'PUT') {
          const payload = JSON.parse(body.toString('utf8')) as {
            title?: string;
            body?: { value?: string };
            version?: { number?: number };
          };
          page.title = payload.title ?? page.title;
          page.body = payload.body?.value ?? page.body;
          page.version = payload.version?.number ?? page.version + 1;
          mock.pageUpdates += 1;
          return json(res, 200, {
            id,
            title: page.title,
            version: { number: page.version },
            _links: { webui: `/spaces/${spaceKey}/pages/${id}/${encodeURIComponent(page.title)}` },
          });
        }
      }

      const attachmentListMatch = /^\/wiki\/rest\/api\/content\/([^/]+)\/child\/attachment$/.exec(path);
      if (attachmentListMatch !== null) {
        const pageId = decodeURIComponent(attachmentListMatch[1] as string);
        const list = attachments.get(pageId) ?? [];
        if (req.method === 'GET') {
          return json(res, 200, {
            results: list.map((item) => ({ id: item.id, title: item.title, version: { number: item.version } })),
          });
        }
        if (req.method === 'POST') {
          const parts = parseMultipart(String(req.headers['content-type'] ?? ''), body);
          const file = parts.find((part) => part.fileName !== null);
          if (file === undefined || file.fileName === null) return json(res, 400, { message: 'no file' });
          attachmentSeq += 1;
          const created: MockAttachment = {
            id: String(attachmentSeq),
            title: file.fileName,
            contentType: file.type,
            bytes: file.data.byteLength,
            version: 1,
          };
          list.push(created);
          attachments.set(pageId, list);
          mock.attachmentUploads += 1;
          return json(res, 200, { results: [{ id: created.id, title: created.title }] });
        }
      }

      const attachmentDataMatch =
        /^\/wiki\/rest\/api\/content\/([^/]+)\/child\/attachment\/([^/]+)\/data$/.exec(path);
      if (attachmentDataMatch !== null && req.method === 'POST') {
        const pageId = decodeURIComponent(attachmentDataMatch[1] as string);
        const attachmentId = decodeURIComponent(attachmentDataMatch[2] as string);
        const list = attachments.get(pageId) ?? [];
        const existing = list.find((item) => item.id === attachmentId);
        if (existing === undefined) return json(res, 404, { message: 'attachment not found' });
        const parts = parseMultipart(String(req.headers['content-type'] ?? ''), body);
        const file = parts.find((part) => part.fileName !== null);
        if (file !== undefined) existing.bytes = file.data.byteLength;
        existing.version += 1;
        mock.attachmentUploads += 1;
        return json(res, 200, { results: [{ id: existing.id, title: existing.title }] });
      }

      return json(res, 404, { message: `unhandled ${req.method} ${path}` });
    })().catch((error: unknown) => {
      json(res, 500, { message: error instanceof Error ? error.message : String(error) });
    });
  });


  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  mock.port = typeof address === 'object' && address !== null ? address.port : 0;
  mock.url = `http://127.0.0.1:${mock.port}`;
  return mock;
}
