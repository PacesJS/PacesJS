import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Manifest } from '@pacesjs/format';
import { startHost } from '../src/server.js';
import type { Host } from '../src/server.js';

let base: string;
let root: string;
let host: Host;
const opened: Array<[string, number]> = [];
const MODEL = new Uint8Array(200_000).map((_, i) => i % 251);
const BASELINE = new Uint8Array([9, 9, 9]);

function manifest(projectRoot: string): Manifest {
  return {
    formatVersion: '1.0.0',
    engineVersion: '0.0.1',
    command: ['node', 'app.js'],
    cwd: projectRoot,
    nodeVersion: 'v24.0.0',
    platform: 'win32',
    mode: 'default',
    intervalUs: 1000,
    startedAt: Date.now() - 60_000,
    endedAt: Date.now() - 50_000,
    endedBy: 'exit',
    projectRoot,
    tracks: [{ id: 'p1', kind: 'process', label: 'main' }],
    sources: [],
  };
}

const api = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${host.port}${path}`, {
    ...init,
    headers: { 'x-paces-token': host.token, ...(init.headers as Record<string, string>) },
  });

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'paces-host-')));
  root = join(base, 'project');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(base, 'ui', 'assets'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(base, 'outside.txt'), 'secret');
  writeFileSync(join(base, 'ui', 'index.html'), '<!doctype html><title>ui</title>');
  writeFileSync(join(base, 'ui', 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(base, 'private.txt'), 'nope');
  host = await startHost({
    session: {
      file: 'x.paces',
      manifest: manifest(root),
      modelBytes: MODEL,
      baseline: { file: 'base.paces', manifest: manifest(root), modelBytes: BASELINE },
      embedded: new Map([['src/gone.ts', new TextEncoder().encode('embedded text')]]),
      info: {
        target: 'app.js',
        primaryTrack: 'p1',
        warningsSummary: { total: 2, byCode: { 'map-missing': 2 } },
      },
    },
    uiDir: join(base, 'ui'),
    configDir: join(base, 'config'),
    openInEditor: (f, l) => opened.push([f, l]),
  });
});
afterAll(async () => {
  await host.close();
  rmSync(base, { recursive: true, force: true });
});

describe('host security', () => {
  it('binds to loopback with a 32-byte (64 hex) token', () => {
    expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}$/);
  });

  it('refuses the document without a token', async () => {
    expect((await fetch(`http://127.0.0.1:${host.port}/`)).status).toBe(401);
  });

  it('refuses the document with a wrong token', async () => {
    expect((await fetch(`http://127.0.0.1:${host.port}/?token=${'0'.repeat(64)}`)).status).toBe(
      401,
    );
  });

  it('serves the document for the token in the query', async () => {
    const res = await fetch(host.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>ui</title>');
  });

  it.each(['/api/session', '/api/model', '/api/settings', '/api/source?path=src/a.ts'])(
    'refuses %s without the header',
    async (path) => {
      expect((await fetch(`http://127.0.0.1:${host.port}${path}`)).status).toBe(401);
    },
  );

  it('does not accept the token as a query parameter on the API', async () => {
    expect(
      (await fetch(`http://127.0.0.1:${host.port}/api/session?token=${host.token}`)).status,
    ).toBe(401);
  });

  it('refuses a request whose Host header is not the loopback address (DNS rebinding)', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      request(
        {
          host: '127.0.0.1',
          port: host.port,
          path: '/api/session',
          headers: { 'x-paces-token': host.token, host: 'evil.example' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      )
        .on('error', reject)
        .end();
    });
    expect(status).toBe(403);
  });

  it('serves bundle assets without the token and stays inside the UI directory', async () => {
    expect((await fetch(`http://127.0.0.1:${host.port}/assets/app.js`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${host.port}/..%2Fprivate.txt`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${host.port}/%2e%2e/private.txt`)).status).toBe(404);
  });
});

describe('/api/session and /api/model', () => {
  it('returns the meta summary and hasBaseline', async () => {
    const body = (await (await api('/api/session')).json()) as {
      meta: { command: string[]; file: string };
      hasBaseline: boolean;
    };
    expect(body.meta.command).toEqual(['node', 'app.js']);
    expect(body.meta.file).toBe('x.paces');
    expect(body.hasBaseline).toBe(true);
  });

  it('returns warningsSummary, target and primaryTrack for the header', async () => {
    const body = (await (await api('/api/session')).json()) as Record<string, unknown>;
    expect(body.warningsSummary).toEqual({ total: 2, byCode: { 'map-missing': 2 } });
    expect(body.target).toBe('app.js');
    expect(body.primaryTrack).toBe('p1');
  });

  it('streams the model bytes unchanged as octet-stream', async () => {
    const res = await api('/api/model');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MODEL);
  });

  it('serves the baseline model with ?which=baseline', async () => {
    expect(new Uint8Array(await (await api('/api/model?which=baseline')).arrayBuffer())).toEqual(
      BASELINE,
    );
  });
});

describe('/api/source', () => {
  const get = async (path: string) => {
    const res = await api(`/api/source?path=${encodeURIComponent(path)}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('returns text, hash and exists for a project-relative file', async () => {
    const { status, body } = await get('src/a.ts');
    expect(status).toBe(200);
    expect(body).toMatchObject({ exists: true, text: 'export const a = 1;\n' });
    expect(body.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('flags a file modified after the profile started', async () => {
    writeFileSync(join(root, 'src', 'b.ts'), 'x');
    const { body } = await get('src/b.ts');
    expect(body.changedSinceProfile).toBe(true);
  });

  it('does not flag a file older than the profile', async () => {
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(root, 'src', 'a.ts'), old, old);
    const { body } = await get('src/a.ts');
    expect(body.changedSinceProfile).toBe(false);
  });

  it('reports a missing file inside the root as exists:false', async () => {
    expect((await get('src/missing.ts')).body.exists).toBe(false);
  });

  it('falls back to the embedded copy of a file that is gone', async () => {
    const { body } = await get('src/gone.ts');
    expect(body).toMatchObject({
      exists: true,
      text: 'embedded text',
      origin: 'embedded',
      status: 'ok',
      changedSinceProfile: false,
    });
  });

  it.each([
    '../outside.txt',
    'src/../../outside.txt',
    join(tmpdir(), 'anything.txt'),
    '\\\\server\\share\\x.ts',
    'C:\\Windows\\win.ini',
  ])('refuses %s without leaking content', async (path) => {
    const { body } = await get(path);
    expect(body).toMatchObject({ exists: false, text: '' });
    expect(body.status).toMatch(/outside-root|missing/);
    expect(body.hint).toBeTypeOf('string');
  });

  it('reports a status and an actionable hint for a missing file inside the root', async () => {
    const { body } = await get('src/missing.ts');
    expect(body).toMatchObject({ exists: false, status: 'missing', origin: 'disk' });
    expect(String(body.hint)).toContain('--embed-sources');
  });

  it('reports outside-root for a real file the profile never loaded', async () => {
    const { body } = await get(join(base, 'outside.txt'));
    expect(body).toMatchObject({ exists: false, status: 'outside-root' });
  });

  it('requires the path parameter', async () => {
    expect((await api('/api/source')).status).toBe(400);
  });
});

describe('/api/open-in-editor', () => {
  const post = (body: unknown) =>
    api('/api/open-in-editor', { method: 'POST', body: JSON.stringify(body) });

  it('opens a file inside the project at a line', async () => {
    expect((await post({ file: 'src/a.ts', line: 7 })).status).toBe(200);
    expect(opened.at(-1)).toEqual([join(root, 'src', 'a.ts'), 7]);
  });

  it('refuses a file outside the project', async () => {
    expect((await post({ file: '../outside.txt', line: 1 })).status).toBe(403);
  });

  it.each([{ file: 'src/a.ts', line: 'x' }, { file: 'src/a.ts', line: 0 }, { line: 3 }])(
    'rejects invalid body %j',
    async (body) => {
      expect((await post(body)).status).toBe(400);
    },
  );
});

describe('/api/settings and /api/heartbeat', () => {
  it('round-trips settings through a JSON file in the config dir', async () => {
    const res = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ theme: 'dark' }),
    });
    expect(res.status).toBe(200);
    expect(await (await api('/api/settings')).json()).toEqual({ theme: 'dark' });
    expect(JSON.parse(readFileSync(join(base, 'config', 'settings.json'), 'utf8'))).toEqual({
      theme: 'dark',
    });
  });

  it('rejects settings that are not an object', async () => {
    expect((await api('/api/settings', { method: 'PUT', body: '[1]' })).status).toBe(400);
  });

  it('records heartbeats', async () => {
    expect(host.lastHeartbeatAt()).toBeUndefined();
    expect((await api('/api/heartbeat', { method: 'POST' })).status).toBe(204);
    expect(host.lastHeartbeatAt()).toBeTypeOf('number');
  });
});
