import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const UI_DIR = resolve(import.meta.dirname, '../../packages/ui');
const VITE_BIN = resolve(UI_DIR, 'node_modules/vite/bin/vite.js');

/** A free port per server: a fixed one collides when Playwright restarts a worker. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitForServer(url: string, child: ChildProcess, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exited: number | null = null;
  child.once('exit', (code) => {
    exited = code ?? -1;
  });
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`vite preview exited early with code ${exited}`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`vite preview did not answer on ${url} within ${timeoutMs} ms`);
}

interface Workers {
  baseUrl: string;
}

/**
 * Serves the built UI plus the dev host API (ORDERS-SERVER fixture) with `vite preview`.
 * Build first: `pnpm --filter @pacesjs/ui build`.
 */
export const test = base.extend<{ app: Page }, Workers>({
  baseUrl: [
    // Playwright needs a destructuring pattern here even though no fixture is used.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      if (!existsSync(resolve(UI_DIR, 'dist/index.html'))) {
        throw new Error('The UI is not built. Run `pnpm --filter @pacesjs/ui build` first.');
      }
      const PORT = await freePort();
      const child = spawn(
        process.execPath,
        [VITE_BIN, 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
        {
          cwd: UI_DIR,
          stdio: 'ignore',
          env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
        },
      );
      const baseUrl = `http://127.0.0.1:${PORT}`;
      try {
        await waitForServer(`${baseUrl}/api/session`, child);
        await use(baseUrl);
      } finally {
        child.kill();
      }
    },
    { scope: 'worker', auto: false },
  ],
  app: async ({ page, baseUrl }, use) => {
    await page.goto(`${baseUrl}/`);
    await expect(page.getByRole('heading', { name: 'Findings' })).toBeVisible();
    await use(page);
  },
});

export { expect };

/** Wait until the overview lanes and the active view have finished loading. */
export async function settled(page: Page): Promise<void> {
  await expect(page.getByText('Loading tracks…')).toHaveCount(0);
  await expect(
    page.getByText(
      /^(Loading waterfall…|Loading flame graph…|Loading functions…|Laying out the call graph…)$/,
    ),
  ).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}
