import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { ROOT, openAndClose, removeDir, runPaces, tempDir } from './helpers/cli.js';

// Needs a real Chromium: PACES_BROWSER=<path to chrome.exe | msedge.exe | chrome>.
const exe = process.env['PACES_BROWSER'];

interface Zoo {
  url(page: string): string;
  close(): Promise<unknown>;
}

async function startZoo(): Promise<Zoo> {
  const mod = (await import(pathToFileURL(join(ROOT, 'zoo', 'browser', 'server.mjs')).href)) as {
    startZoo(): Promise<Zoo>;
  };
  return mod.startZoo();
}

/** Every file inside the session zip, as text, for searching. */
function unzipped(file: string): Record<string, string> {
  const fflate = createRequire(join(ROOT, 'packages', 'format', 'package.json'))('fflate') as {
    unzipSync(bytes: Uint8Array): Record<string, Uint8Array>;
    strFromU8(bytes: Uint8Array): string;
  };
  const files = fflate.unzipSync(new Uint8Array(readFileSync(file)));
  return Object.fromEntries(Object.entries(files).map(([n, b]) => [n, fflate.strFromU8(b)]));
}

test.describe('paces browser: refusals', () => {
  test('refuses a browser path that does not exist, with exit code 2 and what to do', async () => {
    const run = await runPaces([
      'browser',
      'http://localhost:1',
      '--browser',
      'Z:\\no\\such\\browser.exe',
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/does not exist/);
    expect(run.stderr).toMatch(/Chromium/);
  });

  test('needs a URL or --attach', async () => {
    const run = await runPaces(['browser']);
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/URL/);
  });
});

test.describe('paces browser: a real browser', () => {
  test.skip(!exe, 'set PACES_BROWSER to a Chromium executable to run these');
  test.describe.configure({ timeout: 120_000 });

  let zoo: Zoo;
  test.beforeAll(async () => {
    zoo = await startZoo();
  });
  test.afterAll(async () => {
    await zoo.close();
  });

  const record = async (page: string, dir: string, extra: string[] = []) => {
    const out = join(dir, `${page}.paces`);
    const run = await runPaces(
      [
        'browser',
        zoo.url(page),
        '--duration',
        '3',
        '--no-open',
        '--no-keys',
        '--browser',
        exe ?? '',
        '--out',
        out,
        ...extra,
      ],
      { onUrl: async (url) => void (await openAndClose(url)), timeoutMs: 100_000 },
    );
    return { run, out };
  };

  test('records a slow click: the planted finding, named tracks, and no paces code as the program', async () => {
    const dir = tempDir();
    try {
      const { run, out } = await record('slow-click', dir);
      expect(run.code, run.stderr).toBe(0);
      const summary = await runPaces(['summary', out, '--json']);
      const parsed = JSON.parse(summary.stdout) as {
        findings: Array<{ kind: string }>;
        topFunctions: Array<{ file?: string; origin: string }>;
      };
      expect(parsed.findings.map((f) => f.kind)).toContain('slow-interaction');
      const injected = parsed.topFunctions.filter((f) => (f.file ?? '').startsWith('paces://'));
      expect(injected.filter((f) => f.origin === 'user')).toEqual([]);
      expect(run.stderr).toMatch(/Page · |screenshots/);
    } finally {
      removeDir(dir);
    }
  });

  test('says the session has screenshots, and leaves them out with --no-screenshots', async () => {
    const dir = tempDir();
    try {
      const withShots = await record('slow-click', dir);
      expect(withShots.run.stderr).toMatch(/contains screenshots/);
      expect(
        Object.keys(unzipped(withShots.out)).some((n) => n.startsWith('raw/screenshots/')),
      ).toBe(true);
      const without = await record('layout-shift', dir, ['--no-screenshots']);
      expect(without.run.stderr).not.toMatch(/contains screenshots/);
      expect(Object.keys(unzipped(without.out)).some((n) => n.startsWith('raw/screenshots/'))).toBe(
        false,
      );
    } finally {
      removeDir(dir);
    }
  });

  test('never writes a typed secret anywhere in the session', async () => {
    const dir = tempDir();
    try {
      const { run, out } = await record('privacy', dir);
      expect(run.code, run.stderr).toBe(0);
      const files = unzipped(out);
      const hits = Object.entries(files).filter(([, text]) => text.includes('hunter2'));
      expect(hits.map(([name]) => name)).toEqual([]);
      expect(Object.keys(files).length).toBeGreaterThan(5);
    } finally {
      removeDir(dir);
    }
  });

  test('drops query strings from every URL it stored', async () => {
    const dir = tempDir();
    try {
      const { out } = await record('slow-click', dir);
      const manifest = JSON.parse(unzipped(out)['manifest.json'] ?? '{}') as {
        command: string[];
        browser?: { url: string };
      };
      expect(manifest.browser?.url).not.toMatch(/[?#]/);
      expect(manifest.command[1]).not.toMatch(/[?#]/);
    } finally {
      removeDir(dir);
    }
  });
});
