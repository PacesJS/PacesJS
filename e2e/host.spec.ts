import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { goodbye, heartbeat, removeDir, runPaces, tempDir } from './helpers/cli.js';
import { engineReady } from './helpers/engine.js';

// Loads the real UI bundle served by the real CLI host in a real browser and checks that the token
// scheme (document and API gated, bundle assets public) leaves no failed request behind.
test('the host serves the UI bundle and API to a browser with zero failed requests', async () => {
  test.skip(!(await engineReady()), 'the engine does not export the model functions yet');
  const dir = tempDir();
  const out = join(dir, 'host.paces');
  const failures: string[] = [];
  const seen = new Set<string>();
  let title = '';
  try {
    const run = await runPaces(
      ['--no-open', '--out', out, '--', 'node', 'zoo/apps/hot-regex.cjs'],
      {
        onUrl: async (url) => {
          const browser = await chromium.launch();
          try {
            const page = await browser.newPage();
            page.on('requestfailed', (r) => failures.push(`failed ${r.url()}`));
            page.on('response', (r) => {
              seen.add(new URL(r.url()).pathname);
              if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
            });
            const beat = page.waitForResponse((r) => r.url().endsWith('/api/heartbeat'));
            const model = page.waitForResponse((r) => r.url().includes('/api/model'));
            await page.goto(url);
            await beat;
            await model;
            title = await page.title();
            // Leaving the page runs its pagehide handler: the real goodbye beacon is what ends the CLI.
            await page.goto('about:blank');
          } finally {
            await browser.close();
          }
        },
      },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(failures).toEqual([]);
    expect(title).toBe('paces');
    expect([...seen]).toEqual(
      expect.arrayContaining(['/', '/api/session', '/api/model', '/api/heartbeat']),
    );
  } finally {
    removeDir(dir);
  }
});

test('the CLI exits after the window goes quiet and mirrors the target exit code', async () => {
  test.skip(!(await engineReady()), 'the engine does not export the model functions yet');
  const dir = tempDir();
  try {
    const run = await runPaces(
      ['--no-open', '--out', join(dir, 'a.paces'), '--', 'node', '-e', 'process.exit(4)'],
      {
        onUrl: async (url) => {
          await heartbeat(url);
          await goodbye(url);
        },
      },
    );
    expect(run.code).toBe(4);
  } finally {
    removeDir(dir);
  }
});

test('requests without the token are refused', async () => {
  test.skip(!(await engineReady()), 'the engine does not export the model functions yet');
  const dir = tempDir();
  let status = 0;
  let apiStatus = 0;
  try {
    await runPaces(['--no-open', '--out', join(dir, 'a.paces'), '--', 'node', '-e', '0'], {
      onUrl: async (url) => {
        const u = new URL(url);
        status = (await fetch(`${u.origin}/`)).status;
        apiStatus = (await fetch(`${u.origin}/api/model`)).status;
        await heartbeat(url);
        await goodbye(url);
      },
    });
    expect([status, apiStatus]).toEqual([401, 401]);
  } finally {
    removeDir(dir);
  }
});

test('a gap in heartbeats alone does not end the CLI (minimized windows have throttled timers)', async () => {
  test.skip(!(await engineReady()), 'the engine does not export the model functions yet');
  const dir = tempDir();
  try {
    let finished = false;
    let stillRunningAfterSilence: boolean | undefined;
    const run = runPaces(['--no-open', '--out', join(dir, 'a.paces'), '--', 'node', '-e', '0'], {
      env: { PACES_GRACE_MS: '200', PACES_STALE_HEARTBEAT_MS: '60000' },
      onUrl: async (url) => {
        await heartbeat(url);
        // Silence several times longer than the grace period, as a throttled background window gives.
        await new Promise((r) => setTimeout(r, 1500));
        stillRunningAfterSilence = !finished;
        await goodbye(url);
      },
    });
    void run.then(() => {
      finished = true;
    });
    const result = await run;
    expect(stillRunningAfterSilence).toBe(true);
    expect(result.code).toBe(0);
  } finally {
    removeDir(dir);
  }
});

test('heartbeats that stop for longer than the stale threshold end the CLI as a fallback', async () => {
  test.skip(!(await engineReady()), 'the engine does not export the model functions yet');
  const dir = tempDir();
  try {
    const started = Date.now();
    const result = await runPaces(
      ['--no-open', '--out', join(dir, 'a.paces'), '--', 'node', '-e', '0'],
      {
        env: { PACES_GRACE_MS: '200', PACES_STALE_HEARTBEAT_MS: '900' },
        onUrl: async (url) => {
          await heartbeat(url);
        },
      },
    );
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  } finally {
    removeDir(dir);
  }
});
