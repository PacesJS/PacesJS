import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { readSession } from '../packages/format/dist/index.js';
import { PACES_CLI, ROOT, openAndClose, removeDir, tempDir, waitFor } from './helpers/cli.js';
import { engineReady } from './helpers/engine.js';
import { startPacesInConsole } from './helpers/console.js';

const SERVER = join(ROOT, 'e2e', 'fixtures', 'server.mjs');
const fwd = (p: string): string => p.replaceAll('\\', '/');

const urlOf = (text: string): string | undefined =>
  /(http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/.exec(text)?.[1];

function loadSession(file: string) {
  return readSession(new Uint8Array(readFileSync(file)));
}

// Windows: a terminal Ctrl+C reaches the CLI and the target at once. We reproduce that with a real
// CTRL_C_EVENT on a hidden console (see helpers/send-ctrl-c.ps1).
test.describe('Ctrl+C on a long-running server, Windows console', () => {
  test.skip(process.platform !== 'win32', 'real console Ctrl+C is Windows-specific here');

  for (const mode of ['graceful', 'plain'] as const) {
    const expected = mode === 'graceful' ? 0 : 130;
    test(`${mode} app: flushes the profile, saves a session and exits ${expected}`, async () => {
      const dir = tempDir();
      const out = join(dir, 'session.paces');
      const run = startPacesInConsole(
        dir,
        ['--no-open', '--out', fwd(out), '--', 'node', fwd(SERVER)],
        {
          MODE: mode,
          PACES_GRACE_MS: '300',
        },
      );
      try {
        await waitFor(() => existsSync(run.files.ready), 30_000, 'the server to listen');
        // Let a few samples accumulate before interrupting.
        await waitFor(() => run.stdout().includes('listening'), 5_000, 'the listening line');
        run.ctrlC();
        // With the engine present the CLI goes on to serve the UI; closing it ends the run.
        if (await engineReady()) {
          await waitFor(() => urlOf(run.stderr()) !== undefined, 30_000, 'the UI URL');
          await openAndClose(urlOf(run.stderr()) as string);
        }
        const code = await run.exitCode();
        expect(code, `${run.stdout()}\n${run.stderr()}`).toBe(expected);
        expect(existsSync(out)).toBe(true);
        const session = loadSession(out);
        expect(session.manifest.endedBy).toBe('sigint');
        expect(session.capture.tracks[0]?.cpuProfile?.samples.length ?? 0).toBeGreaterThan(0);
        if (mode === 'graceful') expect(run.stdout()).toContain('SIGINT handler ran');
      } finally {
        run.kill();
        removeDir(dir);
      }
    });
  }
});

// POSIX: signal the CLI only (a terminal would also signal the target), which exercises the
// stop -> flush -> emulated-SIGINT path.
test.describe('Ctrl+C on a long-running server, POSIX', () => {
  test.skip(process.platform === 'win32', 'POSIX signal semantics');

  test('flushes, runs the app SIGINT handler and mirrors its exit code', async () => {
    const dir = tempDir();
    const out = join(dir, 'session.paces');
    const ready = join(dir, 'ready');
    const child = spawn(
      process.execPath,
      [PACES_CLI, '--no-open', '--out', out, '--', 'node', SERVER],
      {
        env: { ...process.env, MODE: 'graceful', READY_FILE: ready, PACES_GRACE_MS: '300' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    const exited = new Promise<number | null>((r) => child.on('close', (c) => r(c)));
    try {
      await waitFor(() => existsSync(ready), 30_000, 'the server to listen');
      child.kill('SIGINT');
      if (await engineReady()) {
        await waitFor(() => urlOf(stderr) !== undefined, 30_000, 'the UI URL');
        await openAndClose(urlOf(stderr) as string);
      }
      expect(await exited).toBe(0);
      expect(stdout).toContain('SIGINT handler ran');
      expect(loadSession(out).manifest.endedBy).toBe('sigint');
    } finally {
      child.kill('SIGKILL');
      removeDir(dir);
    }
  });
});
