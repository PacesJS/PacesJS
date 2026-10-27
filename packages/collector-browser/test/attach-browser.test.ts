import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killTree } from '@pacesjs/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { discoverBrowserSocket } from '../src/attach.js';
import { startRecording } from '../src/recorder.js';
import type { BrowserRecording, RecordOptions } from '../src/recorder.js';
// @ts-expect-error the zoo server is plain JavaScript
import { startZoo } from '../../../zoo/browser/server.mjs';

// Needs a real Chromium: PACES_BROWSER=<path to chrome.exe | msedge.exe | chrome>.
const exe = process.env.PACES_BROWSER;

interface Zoo {
  url(page: string): string;
  close(): Promise<unknown>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function untilListening(port: number): Promise<void> {
  const end = Date.now() + 30_000;
  for (;;) {
    try {
      await discoverBrowserSocket(port);
      return;
    } catch (error) {
      if (Date.now() > end) throw error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

describe.runIf(exe)('startRecording: joining a browser that is already running', () => {
  let zoo: Zoo;
  let child: ChildProcess | undefined;
  let profile: string | undefined;
  let port = 0;

  beforeAll(async () => {
    zoo = (await startZoo()) as Zoo;
  });
  afterAll(async () => {
    await zoo.close();
  });
  afterEach(() => {
    if (child) killTree(child);
    child = undefined;
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    profile = undefined;
  });

  async function startUserBrowser(page: string): Promise<void> {
    port = await freePort();
    profile = mkdtempSync(join(tmpdir(), 'paces-attach-'));
    child = spawn(
      exe ?? '',
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--edge-skip-compat-layer-relaunch',
        zoo.url(page),
      ],
      { stdio: 'ignore' },
    );
    await untilListening(port);
  }

  const record = async (extra: Partial<RecordOptions>): Promise<BrowserRecording> => {
    const run = await startRecording({
      url: '',
      exe: '',
      attach: { port },
      screenshots: true,
      startPaused: false,
      fullTrace: false,
      keepQuery: false,
      hiRes: false,
      overlay: true,
      eventMarks: true,
      eventText: true,
      cacheCold: false,
      durationMs: 3000,
      ...extra,
    });
    return run.done;
  };

  it('records the tab the user has open, and leaves the browser running', async () => {
    await startUserBrowser('slow-click');
    const recording = await record({});
    expect(recording.endedBy).toBe('duration');
    expect(recording.events.some((e) => e.name === 'ProfileChunk')).toBe(true);
    expect(
      recording.targets.some((t) => t.type === 'page' && t.url.endsWith('/slow-click.html')),
    ).toBe(true);
    // Still there, and still answering.
    await expect(discoverBrowserSocket(port)).resolves.toMatch(/devtools\/browser/);
  }, 90_000);

  it('opens a new tab for a URL, profiles it, and closes it again, leaving the user tab', async () => {
    await startUserBrowser('layout-shift');
    const recording = await record({ url: zoo.url('forced-layout') });
    expect(recording.targets.some((t) => t.url.endsWith('/forced-layout.html'))).toBe(true);
    expect(recording.events.some((e) => e.name === 'ProfileChunk')).toBe(true);
    const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
      type: string;
      url: string;
    }>;
    const pages = list.filter((t) => t.type === 'page').map((t) => t.url);
    expect(pages.some((u) => u.endsWith('/layout-shift.html'))).toBe(true);
    expect(pages.some((u) => u.endsWith('/forced-layout.html'))).toBe(false);
  }, 90_000);

  it('says how to start the browser when nothing is listening', async () => {
    port = await freePort();
    await expect(record({})).rejects.toThrow(new RegExp(`--remote-debugging-port=${port}`));
  });
});
