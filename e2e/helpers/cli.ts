import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const PACES_CLI = join(ROOT, 'packages', 'paces', 'dist', 'cli.js');
export const ZOO = join(ROOT, 'zoo');

export interface PacesRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The UI URL the CLI printed, if it got that far. */
  url?: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Called once with the printed UI URL; the CLI exits after its grace period once you "close the window". */
  onUrl?: (url: string) => Promise<void> | void;
  timeoutMs?: number;
}

// pnpm leaks `npm_config_*` variables npm does not know, so npm prints warnings to stderr.
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_config_')),
  );
}

export function tempDir(prefix = 'paces-e2e-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Spawns `node dist/cli.js ...args`, returns when it exits. Fails loudly if the bundle is missing. */
export function runPaces(args: string[], options: RunOptions = {}): Promise<PacesRun> {
  if (!existsSync(PACES_CLI)) throw new Error('packages/paces is not built: run pnpm build first.');
  const config = tempDir('paces-config-');
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [PACES_CLI, ...args], {
      cwd: options.cwd ?? ROOT,
      env: {
        ...cleanEnv(),
        PACES_GRACE_MS: '300',
        PACES_CONFIG_DIR: config,
        // npm's own update notices go to stderr and vary by day; they are not paces output.
        NPM_CONFIG_UPDATE_NOTIFIER: 'false',
        NPM_CONFIG_FUND: 'false',
        NPM_CONFIG_AUDIT: 'false',
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const run: PacesRun = { code: null, stdout: '', stderr: '' };
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`paces timed out.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`));
    }, options.timeoutMs ?? 90_000);
    child.stdout.on('data', (d: Buffer) => (run.stdout += d));
    child.stderr.on('data', (d: Buffer) => {
      run.stderr += d;
      if (!run.url) {
        const url = urlOf(run.stderr);
        if (url) {
          run.url = url;
          void Promise.resolve(options.onUrl?.(url)).catch(reject);
        }
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      removeDir(config);
      run.code = code;
      resolvePromise(run);
    });
  });
}

/** The host URL (with its token) that paces printed, if it has printed one yet. */
export function urlOf(text: string): string | undefined {
  return /(http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/.exec(text)?.[1];
}

/** The header a page sends with every request: the token from the URL it was opened with. */
export function authHeaders(url: string): Record<string, string> {
  return { 'x-paces-token': new URL(url).searchParams.get('token') ?? '' };
}

/** One heartbeat, as a loaded page sends. */
export async function heartbeat(url: string): Promise<void> {
  await fetch(`${new URL(url).origin}/api/heartbeat`, {
    method: 'POST',
    headers: authHeaders(url),
  });
}

/** The beacon a page sends from `pagehide` (the token rides in the URL: beacons set no headers). */
export async function goodbye(url: string): Promise<void> {
  const u = new URL(url);
  await fetch(`${u.origin}/api/goodbye?token=${u.searchParams.get('token') ?? ''}`, {
    method: 'POST',
  });
}

/** Behaves like a UI that loaded once and was then closed: a heartbeat, then a goodbye. */
export async function openAndClose(url: string): Promise<{ session: unknown }> {
  const session = await (
    await fetch(`${new URL(url).origin}/api/session`, { headers: authHeaders(url) })
  ).json();
  await heartbeat(url);
  await goodbye(url);
  return { session };
}

/** Polls a condition with a bounded timeout; no fixed sleeps. */
export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  what = 'condition',
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
