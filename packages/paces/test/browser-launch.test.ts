import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Manifest } from '@pacesjs/format';
import {
  appModeArgs,
  findBrowser,
  killTree,
  removeDetached,
  removeQuietly,
} from '../src/launch.js';
import { startHost } from '../src/server.js';

const browser = findBrowser();

describe('removeDetached', () => {
  it('removes the directory in a separate process, without waiting for it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'paces-browser-'));
    writeFileSync(join(dir, 'leftover'), 'x');
    removeDetached(dir);
    const end = Date.now() + 10_000;
    while (existsSync(dir) && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(dir)).toBe(false);
  });
});

describe.skipIf(!browser)('launching an installed Chromium browser in app mode', () => {
  it('loads the host page with its token and the page sends a heartbeat', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'paces-browser-'));
    const manifest = {
      formatVersion: '1.0.0',
      engineVersion: '0',
      command: ['node', 'x.js'],
      cwd: dir,
      nodeVersion: process.version,
      platform: process.platform,
      mode: 'default',
      intervalUs: 1000,
      startedAt: 0,
      endedAt: 1,
      endedBy: 'exit',
      projectRoot: dir,
      tracks: [],
      sources: [],
    } as Manifest;
    const host = await startHost({
      session: { file: 'x.paces', manifest, modelBytes: new Uint8Array([1]) },
      configDir: join(dir, 'config'),
    });
    // Headless keeps the test window-less; the other flags are the ones the CLI passes.
    const child = spawn(
      browser as string,
      ['--headless=new', ...appModeArgs(host.url, join(dir, 'profile'))],
      { stdio: 'ignore' },
    );
    try {
      const end = Date.now() + 30_000;
      while (host.lastHeartbeatAt() === undefined && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(host.lastHeartbeatAt()).toBeTypeOf('number');
    } finally {
      killTree(child);
      await host.close();
      removeQuietly(dir);
    }
  }, 40_000);
});
