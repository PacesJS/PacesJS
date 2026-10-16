import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Manifest } from '@pacesjs/format';
import { createSourceResolver } from './source-resolver.js';
import { readSettings, writeSettings } from './settings.js';

export interface HostSession {
  /** Session file path, shown in the UI header. */
  file: string;
  manifest: Manifest;
  modelBytes: Uint8Array;
  /** Differential mode: the baseline session. */
  baseline?: { file: string; manifest: Manifest; modelBytes: Uint8Array };
  /** Embedded sources by project-relative path. */
  embedded?: Map<string, Uint8Array>;
  /** URLs of every script the profiled processes parsed: files V8 loaded may be read for source. */
  scriptUrls?: string[];
  /** Source maps by script URL; their `sourcesContent` backs original files that are not on disk. */
  sourceMaps?: Record<string, string>;
  /** Headline facts for the UI header, from the model. */
  info?: { target?: unknown; primaryTrack?: unknown; warningsSummary?: unknown };
}

export interface HostOptions {
  session: HostSession;
  /** Directory with the built UI (index.html + assets). A placeholder page is served without it. */
  uiDir?: string;
  configDir: string;
  /** Fixed token for tests; defaults to 32 random bytes. */
  token?: string;
  openInEditor?: (file: string, line: number) => void;
}

export interface Host {
  url: string;
  port: number;
  token: string;
  /** Epoch ms of the last request of any kind. */
  lastRequestAt(): number;
  /** Epoch ms of the last heartbeat, if the UI ever sent one. */
  lastHeartbeatAt(): number | undefined;
  /** Epoch ms of the last "page is going away" beacon, if any. */
  lastGoodbyeAt(): number | undefined;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

const MAX_BODY = 1 << 20;
const CHUNK = 1 << 16;

export const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>paces</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>:root{color-scheme:light dark}body{font:16px system-ui,sans-serif;margin:48px auto;max-width:44rem;padding:0 16px}code{font-family:ui-monospace,monospace}</style>
</head><body><h1>paces</h1><p id="status">Loading session...</p>
<script>
const token = new URL(location.href).searchParams.get('token') || '';
const headers = { 'x-paces-token': token };
fetch('/api/session', { headers }).then(r => r.json()).then(s => {
  document.getElementById('status').textContent = 'Session: ' + s.meta.command.join(' ') + ' (' + s.meta.tracks.length + ' track(s)). The paces UI bundle is not built yet.';
});
setInterval(() => fetch('/api/heartbeat', { method: 'POST', headers }), 2000);
</script></body></html>`;

function tokenOk(expected: Buffer, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  return a.length === expected.length && timingSafeEqual(a, expected);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_BODY) throw new Error('body too large');
    parts.push(b);
  }
  return Buffer.concat(parts).toString('utf8');
}

function streamBytes(res: ServerResponse, bytes: Uint8Array): void {
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
  });
  let offset = 0;
  const pump = (): void => {
    while (offset < bytes.length) {
      const end = Math.min(offset + CHUNK, bytes.length);
      const ok = res.write(bytes.subarray(offset, end));
      offset = end;
      if (!ok) {
        res.once('drain', pump);
        return;
      }
    }
    res.end();
  };
  pump();
}

function meta(file: string, m: Manifest): Record<string, unknown> {
  return { ...m, file, sources: m.sources.length };
}

export async function startHost(options: HostOptions): Promise<Host> {
  const { session, configDir, uiDir } = options;
  const token = options.token ?? randomBytes(32).toString('hex');
  const expected = Buffer.from(token);
  let lastRequest = Date.now();
  let lastHeartbeat: number | undefined;
  let lastGoodbye: number | undefined;
  let port = 0;

  const staticFile = (pathname: string): string | undefined => {
    if (!uiDir) return undefined;
    const root = resolve(uiDir);
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return undefined;
    }
    const file = resolve(root, `.${rel}`);
    if (!file.startsWith(root + sep)) return undefined;
    try {
      return statSync(file).isFile() ? file : undefined;
    } catch {
      return undefined;
    }
  };

  const serveDocument = (res: ServerResponse): void => {
    const index = uiDir ? join(uiDir, 'index.html') : undefined;
    const html = index && existsSync(index) ? readFileSync(index, 'utf8') : PLACEHOLDER_HTML;
    res.writeHead(200, { 'content-type': MIME['.html'] as string, 'cache-control': 'no-store' });
    res.end(html);
  };

  const resolver = createSourceResolver({
    projectRoot: session.manifest.projectRoot,
    scriptUrls: session.scriptUrls ?? [],
    sourceMaps: session.sourceMaps ?? {},
    ...(session.embedded ? { embedded: session.embedded } : {}),
    startedAt: session.manifest.startedAt,
  });

  const sourceApi = (url: URL, res: ServerResponse): void => {
    const requested = url.searchParams.get('path');
    if (!requested) return json(res, 400, { error: 'path is required' });
    json(res, 200, resolver.resolve(requested));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    lastRequest = Date.now();
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(403).end('Forbidden host');
      return;
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const method = req.method ?? 'GET';
    const p = url.pathname;
    const isApi = p.startsWith('/api/');
    const isDoc = p === '/' || p === '/index.html';

    if (isApi || isDoc) {
      const header = req.headers['x-paces-token'];
      // `sendBeacon` cannot set headers, so the goodbye beacon may carry the token in the URL.
      const queryToken = isDoc || p === '/api/goodbye';
      const given =
        (Array.isArray(header) ? header[0] : header) ??
        (queryToken ? url.searchParams.get('token') : null);
      if (!tokenOk(expected, given)) {
        res
          .writeHead(401, { 'content-type': 'text/plain' })
          .end('Missing or invalid token. Use the URL printed by paces.');
        return;
      }
    }

    if (isDoc && method === 'GET') return serveDocument(res);

    if (!isApi) {
      // The UI bundle is public (it ships in the npm package); the browser cannot attach the token
      // header to module, worker or font requests, so only session data and `/` are token-gated.
      const file = method === 'GET' ? staticFile(p) : undefined;
      if (!file) {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(readFileSync(file));
      return;
    }

    if (p === '/api/goodbye' && method === 'POST') {
      lastGoodbye = Date.now();
      res.writeHead(204).end();
      return;
    }
    if (p === '/api/heartbeat' && method === 'POST') {
      lastHeartbeat = Date.now();
      res.writeHead(204).end();
      return;
    }
    if (p === '/api/session' && method === 'GET') {
      return json(res, 200, {
        meta: meta(session.file, session.manifest),
        hasBaseline: session.baseline !== undefined,
        warningsSummary: session.info?.warningsSummary ?? { total: 0, byCode: {} },
        target: session.info?.target ?? null,
        primaryTrack: session.info?.primaryTrack ?? null,
        ...(session.baseline
          ? { baseline: meta(session.baseline.file, session.baseline.manifest) }
          : {}),
      });
    }
    if (p === '/api/model' && method === 'GET') {
      const which = url.searchParams.get('which');
      if (which === 'baseline') {
        if (!session.baseline)
          return json(res, 404, { error: 'no baseline: this is not a diff session' });
        return streamBytes(res, session.baseline.modelBytes);
      }
      return streamBytes(res, session.modelBytes);
    }
    if (p === '/api/source' && method === 'GET') return sourceApi(url, res);
    if (p === '/api/open-in-editor' && method === 'POST') {
      let body: { file?: unknown; line?: unknown };
      try {
        body = JSON.parse(await readBody(req)) as typeof body;
      } catch {
        return json(res, 400, { error: 'invalid JSON body' });
      }
      if (
        typeof body.file !== 'string' ||
        !Number.isInteger(body.line) ||
        (body.line as number) < 1
      ) {
        return json(res, 400, { error: 'file (string) and line (positive integer) are required' });
      }
      const file = resolver.diskPath(body.file);
      if (!file)
        return json(res, 403, { error: 'file is missing or outside the profiled project' });
      options.openInEditor?.(file, body.line as number);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/settings') {
      if (method === 'GET') return json(res, 200, readSettings(configDir));
      if (method === 'PUT') {
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return json(res, 400, { error: 'invalid JSON body' });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return json(res, 400, { error: 'settings must be a JSON object' });
        }
        writeSettings(configDir, body as Record<string, unknown>);
        return json(res, 200, body);
      }
    }
    json(res, 404, { error: 'not found' });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ok);
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    lastRequestAt: () => lastRequest,
    lastHeartbeatAt: () => lastHeartbeat,
    lastGoodbyeAt: () => lastGoodbye,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
