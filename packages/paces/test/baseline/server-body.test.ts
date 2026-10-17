// Characterization test for the safe-refactor run: how the host answers bad request bodies today.
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Manifest } from '@pacesjs/format';
import { startHost } from '../../src/server.js';
import type { Host } from '../../src/server.js';

let dir: string;
let host: Host;

const manifest: Manifest = {
  formatVersion: '1.0.0',
  engineVersion: '0.0.1',
  command: ['node', 'app.js'],
  cwd: '/p',
  nodeVersion: 'v24.0.0',
  platform: 'win32',
  mode: 'default',
  intervalUs: 1000,
  startedAt: 1,
  endedAt: 2,
  endedBy: 'exit',
  projectRoot: '/p',
  tracks: [{ id: 'p1', kind: 'process', label: 'main' }],
  sources: [],
};

const send = async (path: string, method: string, body: string) => {
  const r = await fetch(`http://127.0.0.1:${host.port}${path}`, {
    method,
    body,
    headers: { 'x-paces-token': host.token, 'content-type': 'application/json' },
  });
  return { status: r.status, body: await r.text() };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'paces-body-'));
  host = await startHost({
    session: {
      file: 'x.paces',
      manifest,
      modelBytes: new Uint8Array(4),
      embedded: new Map(),
      info: { target: null, primaryTrack: null, warningsSummary: { total: 0, byCode: {} } },
    },
    configDir: dir,
  });
});
afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('request bodies', () => {
  it('open-in-editor answers invalid JSON with 400 invalid JSON body', async () => {
    expect(await send('/api/open-in-editor', 'POST', '{nope')).toEqual({
      status: 400,
      body: JSON.stringify({ error: 'invalid JSON body' }),
    });
  });

  it('settings answers invalid JSON with 400 invalid JSON body', async () => {
    expect(await send('/api/settings', 'PUT', 'not json')).toEqual({
      status: 400,
      body: JSON.stringify({ error: 'invalid JSON body' }),
    });
  });

  it('an oversize body also reads as invalid JSON body', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(1_200_000) });
    const got = await new Promise<{ status: number; body: string }>((resolveReply, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: host.port,
          path: '/api/settings',
          method: 'PUT',
          headers: { 'x-paces-token': host.token, 'content-type': 'application/json' },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (d: string) => (body += d));
          res.on('end', () => resolveReply({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end(big);
    });
    expect(got).toEqual({ status: 400, body: JSON.stringify({ error: 'invalid JSON body' }) });
  });

  it('settings rejects a non-object and echoes a valid one', async () => {
    expect(await send('/api/settings', 'PUT', '[1]')).toEqual({
      status: 400,
      body: JSON.stringify({ error: 'settings must be a JSON object' }),
    });
    expect(await send('/api/settings', 'PUT', '{"theme":"dark"}')).toEqual({
      status: 200,
      body: JSON.stringify({ theme: 'dark' }),
    });
  });

  it('open-in-editor validates file and line', async () => {
    expect(await send('/api/open-in-editor', 'POST', '{"file":"a.ts","line":0}')).toEqual({
      status: 400,
      body: JSON.stringify({ error: 'file (string) and line (positive integer) are required' }),
    });
  });
});
