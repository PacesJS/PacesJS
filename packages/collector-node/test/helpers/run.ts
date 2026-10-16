import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PRELOAD_CJS = new URL('../../dist/preload.cjs', import.meta.url);

export interface RunResult {
  dir: string;
  code: number | null;
  stdout: string;
  stderr: string;
}

export function newSessionDir(): string {
  return mkdtempSync(join(tmpdir(), 'paces-test-'));
}

/** Runs `node <args>` with the preload injected the way the CLI does it. */
export function runWithPreload(
  args: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  const dir = newSessionDir();
  const preload = new URL(PRELOAD_CJS).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const nodeOptions = `--require "${preload}"`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptions,
        PACES_DIR: dir,
        PACES_SESSION: 'test',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ dir, code, stdout, stderr }));
  });
}

export function rawFiles(dir: string): string[] {
  const raw = join(dir, 'raw');
  return existsSync(raw) ? readdirSync(raw).sort() : [];
}

export function readRaw(dir: string, name: string): string {
  return readFileSync(join(dir, 'raw', name), 'utf8');
}

export { pathToFileURL };
