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
  /** Zoo capture the dev host serves as the baseline session (differential mode); null for none. */
  baselineFixture: string | null;
  /** Start (once per worker) a preview server for another capture and return its URL. */
  serve(fixture: string, baseline?: string, modelFile?: string): Promise<string>;
}

interface Preview {
  url: string;
  stop(): void;
}

async function startPreview(env: Record<string, string>): Promise<Preview> {
  if (!existsSync(resolve(UI_DIR, 'dist/index.html'))) {
    throw new Error('The UI is not built. Run `pnpm --filter @pacesjs/ui build` first.');
  }
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [VITE_BIN, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: UI_DIR,
      stdio: 'ignore',
      env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true', ...env },
    },
  );
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(`${url}/api/session`, child);
  } catch (e) {
    child.kill();
    throw e;
  }
  return { url, stop: () => child.kill() };
}

/**
 * Serves the built UI plus the dev host API (ORDERS-SERVER fixture by default) with
 * `vite preview`. Build first: `pnpm --filter @pacesjs/ui build`.
 */
export const test = base.extend<{ app: Page }, Workers>({
  baselineFixture: [null, { option: true, scope: 'worker' }],
  baseUrl: [
    async ({ baselineFixture }, use) => {
      const preview = await startPreview(
        baselineFixture ? { PACES_DEV_BASELINE: baselineFixture } : {},
      );
      try {
        await use(preview.url);
      } finally {
        preview.stop();
      }
    },
    { scope: 'worker', auto: false },
  ],
  serve: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const running = new Map<string, Preview>();
      try {
        await use(async (fixture, baseline, modelFile) => {
          const key = `${fixture}|${baseline ?? ''}|${modelFile ?? ''}`;
          let preview = running.get(key);
          if (!preview) {
            preview = await startPreview({
              PACES_DEV_FIXTURE: fixture,
              ...(baseline ? { PACES_DEV_BASELINE: baseline } : {}),
              ...(modelFile ? { PACES_DEV_MODEL_FILE: modelFile } : {}),
            });
            running.set(key, preview);
          }
          return preview.url;
        });
      } finally {
        for (const p of running.values()) p.stop();
      }
    },
    { scope: 'worker', auto: false },
  ],
  app: async ({ page, baseUrl }, use) => {
    await page.goto(`${baseUrl}/`);
    await expect(page.getByRole('heading', { name: 'Findings' })).toBeVisible();
    // Passive effects (key listeners) can land a frame after first paint; let them flush.
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    await use(page);
  },
});

export { expect };

/** Open the UI on another zoo capture and wait for the findings. */
export async function openFixture(
  page: Page,
  serve: (fixture: string, baseline?: string, modelFile?: string) => Promise<string>,
  fixture: string,
  modelFile?: string,
): Promise<void> {
  await page.goto(`${await serve(fixture, undefined, modelFile)}/`);
  await expect(page.getByRole('heading', { name: 'Findings' })).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}

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
