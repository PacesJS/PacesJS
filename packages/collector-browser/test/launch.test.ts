import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { browserArgs, launchBrowser } from '../src/launch.js';
import type { LaunchedBrowser } from '../src/launch.js';

describe('browserArgs', () => {
  it('uses the private pipe, a throwaway profile and a single about:blank tab', () => {
    const args = browserArgs('/tmp/p');
    expect(args).toContain('--remote-debugging-pipe');
    expect(args).toContain('--user-data-dir=/tmp/p');
    expect(args.filter((a) => a === 'about:blank')).toHaveLength(1);
  });

  it('keeps the browser alive after the last window closes, so the trace can still be collected', () => {
    expect(browserArgs('/tmp/p')).toContain('--keep-alive-for-test');
  });

  it('stops Edge from relaunching itself, which would leave paces holding a closed pipe', () => {
    expect(browserArgs('/tmp/p')).toContain('--edge-skip-compat-layer-relaunch');
  });

  it('never opens a TCP debugging port', () => {
    expect(browserArgs('/tmp/p').some((a) => a.startsWith('--remote-debugging-port'))).toBe(false);
  });
});

// Needs a real Chromium: PACES_BROWSER=<path to chrome.exe | msedge.exe | chrome>.
const exe = process.env.PACES_BROWSER;

describe.runIf(exe)('launchBrowser (real browser)', () => {
  let browser: LaunchedBrowser | undefined;
  let profile: string | undefined;

  const start = (): LaunchedBrowser => {
    profile = mkdtempSync(join(tmpdir(), 'paces-browser-test-'));
    browser = launchBrowser({ exe: exe ?? '', profileDir: profile });
    return browser;
  };

  afterEach(() => {
    browser?.kill();
    browser = undefined;
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    profile = undefined;
  });

  it('answers Browser.getVersion over the pipe', async () => {
    const b = start();
    const version = (await b.client.send('Browser.getVersion')) as { product: string };
    expect(version.product).toMatch(/Chrome|Edg|Brave|Chromium/);
  });

  it('stays alive after its last page is closed, and exits when asked to', async () => {
    const b = start();
    const { targetInfos } = (await b.client.send('Target.getTargets')) as {
      targetInfos: { targetId: string; type: string }[];
    };
    const pages = targetInfos.filter((t) => t.type === 'page');
    expect(pages.length).toBeGreaterThan(0);
    await Promise.all(
      pages.map((p) => b.client.send('Target.closeTarget', { targetId: p.targetId })),
    );
    // Still answering: the trace of a closed window can still be collected.
    const version = (await b.client.send('Browser.getVersion')) as { product: string };
    expect(version.product).toMatch(/Chrome|Edg|Brave|Chromium/);
    await b.client.send('Browser.close');
    await b.client.closed;
    await expect(b.exited).resolves.toBeDefined();
  });

  it('kill ends a browser that is still running', async () => {
    const b = start();
    await b.client.send('Browser.getVersion');
    b.kill();
    await expect(b.exited).resolves.toBeDefined();
  });
});
