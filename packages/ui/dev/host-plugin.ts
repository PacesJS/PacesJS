// Dev and e2e host: serves the paces host API from the ORDERS-SERVER fixture so the real UI can
// run without the CLI. Used by `vite` (dev) and `vite preview` (Playwright).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as engine from '@pacesjs/engine';
import type { ExecutionModel, RawCapture } from '@pacesjs/engine';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';

const repoRoot = resolve(import.meta.dirname, '../../..');
const fixtureName = process.env['PACES_DEV_FIXTURE'] ?? 'orders-server';

function loadModel(name: string): ExecutionModel {
  const file = resolve(repoRoot, `packages/engine/test/fixtures/${name}.capture.json.gz`);
  const raw = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as RawCapture;
  return engine.analyze(raw);
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function createHost(): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  // PACES_DEV_MODEL_FILE serves a model that was serialized earlier (the CLI's cached model),
  // so the UI is exercised on deserialized data and not only on a freshly analyzed model.
  const modelFile = process.env['PACES_DEV_MODEL_FILE'];
  const bytes = modelFile ? new Uint8Array(readFileSync(modelFile)) : null;
  const model = bytes ? engine.deserializeModel(bytes) : loadModel(fixtureName);
  const modelBytes = bytes ?? engine.serializeModel(model);
  const baselineName = process.env['PACES_DEV_BASELINE'];
  const baselineBytes = baselineName ? engine.serializeModel(loadModel(baselineName)) : null;
  let settings: Record<string, unknown> = {};

  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return next();
    const route = url.pathname.slice(5);
    if (route === 'session') {
      return json(res, {
        meta: {
          command: model.meta.command,
          durationUs: model.meta.durationUs,
          tracks: model.tracks.map((t) => ({ id: t.id, label: t.label })),
          sessionPath: `.paces/${fixtureName}.paces`,
        },
        hasBaseline: baselineBytes !== null,
      });
    }
    if (route === 'model') {
      const out = url.searchParams.get('which') === 'baseline' ? baselineBytes : modelBytes;
      if (!out) return json(res, { error: 'no baseline' }, 404);
      res.setHeader('content-type', 'application/octet-stream');
      return void res.end(Buffer.from(out));
    }
    if (route === 'source') {
      const raw = url.searchParams.get('path') ?? '';
      const rel = raw.replace(/^file:\/\/\/?/, '');
      const abs = resolve(repoRoot, rel);
      if (!abs.startsWith(repoRoot + sep) || !existsSync(abs)) {
        return json(res, { exists: false, text: '', hash: '', changedSinceProfile: false });
      }
      const text = readFileSync(abs, 'utf8');
      const hash = createHash('sha1').update(text).digest('hex');
      return json(res, {
        exists: true,
        text,
        hash,
        changedSinceProfile: process.env['PACES_DEV_CHANGED'] === '1',
      });
    }
    if (route === 'open-in-editor') {
      void readBody(req).then(() => json(res, { ok: true }));
      return;
    }
    if (route === 'settings') {
      if (req.method === 'PUT') {
        void readBody(req).then((b) => {
          settings = JSON.parse(b) as Record<string, unknown>;
          json(res, settings);
        });
        return;
      }
      return json(res, settings);
    }
    if (route === 'heartbeat') {
      res.statusCode = 204;
      return void res.end();
    }
    json(res, { error: 'not found' }, 404);
  };
}

export function pacesDevHost(): Plugin {
  const handler = createHost();
  return {
    name: 'paces-dev-host',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use(handler);
    },
  };
}
