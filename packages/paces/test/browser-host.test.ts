import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Manifest } from '@pacesjs/format';
import { startHost } from '../src/server.js';
import type { Host } from '../src/server.js';
import { createSourceResolver } from '../src/source-resolver.js';

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

function manifest(): Manifest {
  return {
    formatVersion: '1.1.0',
    engineVersion: '0',
    command: ['browser', 'http://x.test/'],
    cwd: '/p',
    nodeVersion: 'Edg/1',
    platform: 'win32',
    mode: 'default',
    intervalUs: 1000,
    startedAt: 0,
    endedAt: 1,
    endedBy: 'stop',
    projectRoot: '/p',
    tracks: [],
    sources: [],
    kind: 'browser',
  };
}

describe('host: screenshots', () => {
  let dir: string;
  let host: Host;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${host.port}${path}`, {
      ...init,
      headers: { 'x-paces-token': host.token, ...(init.headers as Record<string, string>) },
    });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'paces-shots-'));
    host = await startHost({
      session: {
        file: 'run.paces',
        manifest: manifest(),
        modelBytes: new Uint8Array(3),
        screenshots: new Map([[4, JPEG]]),
      },
      configDir: dir,
    });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves a frame as a JPEG', async () => {
    const res = await api('/api/screenshot/4');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
  });

  it('answers 404 for a frame the session does not hold', async () => {
    expect((await api('/api/screenshot/9')).status).toBe(404);
  });

  it('answers 404, not an error, for something that is not a frame id', async () => {
    expect((await api('/api/screenshot/abc')).status).toBe(404);
    expect((await api('/api/screenshot/-1')).status).toBe(404);
  });

  it('needs the token', async () => {
    const res = await fetch(`http://127.0.0.1:${host.port}/api/screenshot/4`);
    expect(res.status).toBe(401);
  });

  it('does not let the browser cache the screenshots', async () => {
    expect((await api('/api/screenshot/4')).headers.get('cache-control')).toBe('no-store');
  });
});

describe('source resolver: scripts a browser parsed', () => {
  const url = 'http://127.0.0.1:3000/app/main.js';
  const resolver = createSourceResolver({
    projectRoot: process.cwd(),
    scriptUrls: [url],
    sourceMaps: {},
    urlSources: new Map([[url, new TextEncoder().encode('const a = 1;\n')]]),
    startedAt: 0,
  });

  it('serves the text that was embedded for a script URL', () => {
    const result = resolver.resolve(url);
    expect(result).toMatchObject({
      exists: true,
      status: 'ok',
      origin: 'embedded',
      text: 'const a = 1;\n',
    });
  });

  it('serves it even when the URL carries a query string the session dropped', () => {
    expect(resolver.resolve(`${url}?v=3`).text).toBe('const a = 1;\n');
  });

  it('says why when a script was not saved, instead of looking on disk', () => {
    const result = resolver.resolve('http://127.0.0.1:3000/other.js');
    expect(result.exists).toBe(false);
    expect(result.status).toBe('no-embedded-source');
    expect(result.hint).toMatch(/not saved/);
  });

  it('never offers a script URL as a file to open in an editor', () => {
    expect(resolver.diskPath(url)).toBeUndefined();
  });
});
