import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACES_CLI, ROOT, waitFor } from './cli.js';

const fwd = (p: string): string => p.replaceAll('\\', '/');

export interface ConsoleRun {
  /** PID of the cmd.exe that owns the hidden console. */
  pid: number;
  files: { ready: string; out: string; err: string; code: string };
  /** Sends a real console Ctrl+C: every process on that console gets it, like a terminal would. */
  ctrlC(): void;
  /** Waits for the command to finish and returns its exit code as cmd saw it. */
  exitCode(timeoutMs?: number): Promise<number>;
  stdout(): string;
  stderr(): string;
  kill(): void;
}

/**
 * Windows only. Runs `node dist/cli.js ...args` in its own hidden console so a test can send a real
 * Ctrl+C (CTRL_C_EVENT) without signalling itself. Output goes to files because the console is detached.
 */
export function startPacesInConsole(
  dir: string,
  args: string[],
  env: Record<string, string>,
): ConsoleRun {
  const files = {
    ready: join(dir, 'ready'),
    out: join(dir, 'out.log'),
    err: join(dir, 'err.log'),
    code: join(dir, 'code.txt'),
  };
  const quoted = args.map((a) => (/[\s&|<>^()]/.test(a) ? `"${a}"` : a)).join(' ');
  // `!errorlevel!` (delayed expansion) is the status of the command that just ran.
  const commandLine =
    `node ${fwd(PACES_CLI)} ${quoted} > ${fwd(files.out)} 2> ${fwd(files.err)} & ` +
    `echo !errorlevel! > ${fwd(files.code)}`;
  const launch = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(ROOT, 'e2e', 'helpers', 'launch-in-console.ps1'),
      '-CommandLine',
      commandLine,
    ],
    { encoding: 'utf8', env: { ...process.env, READY_FILE: files.ready, ...env } },
  );
  const pid = Number(launch.stdout.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`could not start a console: ${launch.stdout}${launch.stderr}`);
  }
  const read = (f: string): string => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  return {
    pid,
    files,
    ctrlC() {
      const r = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(ROOT, 'e2e', 'helpers', 'send-ctrl-c.ps1'),
          '-ProcessId',
          String(pid),
        ],
        { encoding: 'utf8' },
      );
      if (r.status !== 0) throw new Error(`could not attach to the console (status ${r.status})`);
    },
    async exitCode(timeoutMs = 30_000) {
      await waitFor(() => existsSync(files.code), timeoutMs, 'the command to finish');
      return Number(read(files.code).trim());
    },
    stdout: () => read(files.out),
    stderr: () => read(files.err),
    kill() {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    },
  };
}
