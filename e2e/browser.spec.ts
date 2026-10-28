import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
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

  test('records a slow click: the planted finding, screenshots, no paces code as the program, no query strings', async () => {
    const dir = tempDir();
    try {
      const { run, out } = await record('slow-click', dir);
      expect(run.code, run.stderr).toBe(0);
      expect(run.stderr).toMatch(/contains screenshots/);
      const files = unzipped(out);
      expect(Object.keys(files).some((n) => n.startsWith('raw/screenshots/'))).toBe(true);
      const manifest = JSON.parse(files['manifest.json'] ?? '{}') as {
        command: string[];
        browser?: { url: string };
      };
      expect(manifest.browser?.url).not.toMatch(/[?#]/);
      expect(manifest.command[1]).not.toMatch(/[?#]/);

      const summary = await runPaces(['summary', out, '--json']);
      const parsed = JSON.parse(summary.stdout) as {
        findings: Array<{ kind: string }>;
        topFunctions: Array<{ file?: string; origin: string }>;
      };
      expect(parsed.findings.map((f) => f.kind)).toContain('slow-interaction');
      const injected = parsed.topFunctions.filter((f) => (f.file ?? '').startsWith('paces://'));
      expect(injected.filter((f) => f.origin === 'user')).toEqual([]);
    } finally {
      removeDir(dir);
    }
  });

  test('never writes a typed secret, a response header or a cookie anywhere in the session', async () => {
    const dir = tempDir();
    try {
      const { run, out } = await record('privacy', dir);
      expect(run.code, run.stderr).toBe(0);
      const files = unzipped(out);
      const leaks = Object.entries(files).filter(([, text]) =>
        /hunter2|cookie-secret|set-cookie/i.test(text),
      );
      expect(leaks.map(([name]) => name)).toEqual([]);
      // The request itself is recorded; only its headers are not.
      expect(files['raw/requests.events']).toContain('/vendor.js');
    } finally {
      removeDir(dir);
    }
  });

  test('joins a browser the user started, records its open tab, and leaves it running', async () => {
    const dir = tempDir();
    const profile = mkdtempSync(join(tmpdir(), 'paces-e2e-profile-'));
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const free = typeof address === 'object' && address ? address.port : 0;
        probe.close(() => resolve(free));
      });
    });
    const child: ChildProcess = spawn(
      exe ?? '',
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--edge-skip-compat-layer-relaunch',
        zoo.url('slow-click'),
      ],
      { stdio: 'ignore' },
    );
    try {
      const end = Date.now() + 30_000;
      for (;;) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
        } catch {
          // not listening yet
        }
        if (Date.now() > end) throw new Error('the browser did not start listening');
        await new Promise((r) => setTimeout(r, 100));
      }
      const out = join(dir, 'joined.paces');
      const run = await runPaces(
        [
          'browser',
          '--attach',
          String(port),
          '--duration',
          '3',
          '--no-open',
          '--no-keys',
          '--out',
          out,
        ],
        { onUrl: async (url) => void (await openAndClose(url)), timeoutMs: 100_000 },
      );
      expect(run.code, run.stderr).toBe(0);
      expect(run.stderr).toMatch(/joined the browser on 127\.0\.0\.1/);
      const manifest = JSON.parse(unzipped(out)['manifest.json'] ?? '{}') as { kind?: string };
      expect(manifest.kind).toBe('browser');
      // The user's browser is still there.
      expect((await fetch(`http://127.0.0.1:${port}/json/version`)).ok).toBe(true);
    } finally {
      if (child.pid !== undefined) {
        if (process.platform === 'win32')
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else child.kill('SIGKILL');
      }
      await new Promise((r) => setTimeout(r, 500));
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      removeDir(dir);
    }
  });
});
