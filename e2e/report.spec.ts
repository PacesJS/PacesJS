import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { removeDir, runPaces, tempDir } from './helpers/cli.js';

// Loads the real UI bundle served by the real CLI host in a real browser and checks that the token
// scheme (document and API gated, bundle assets public) leaves no failed request behind.
test('opens a report: the host serves the UI bundle and API to a browser with zero failed requests', async () => {
  const dir = tempDir();
  const out = join(dir, 'host.paces');
  const failures: string[] = [];
  const seen = new Set<string>();
  const external: string[] = [];
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
            page.on('request', (r) => {
              if (new URL(r.url()).origin !== new URL(url).origin) external.push(r.url());
            });
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
    // The UI loads nothing from the network beyond the host that served it.
    expect(external).toEqual([]);
    expect(title).toBe('paces');
    expect([...seen]).toEqual(
      expect.arrayContaining(['/', '/api/session', '/api/model', '/api/heartbeat']),
    );
  } finally {
    removeDir(dir);
  }
});
