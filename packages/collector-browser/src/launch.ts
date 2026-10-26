import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { killTree } from '@pacesjs/shared';
import { createCdpClient } from './cdp-pipe.js';
import type { CdpClient } from './cdp-pipe.js';

export interface LaunchOptions {
  exe: string;
  profileDir: string;
  windowSize?: string;
}

export interface LaunchedBrowser {
  child: ChildProcess;
  client: CdpClient;
  /** Resolves with the exit code once the browser process has ended. */
  exited: Promise<number | null>;
  /** Ends the browser and every helper process. */
  kill(): void;
}

/**
 * One startup tab: paces attaches to it, injects, then navigates. An extra tab would keep the
 * browser alive after the profiled page closes.
 */
export function browserArgs(profileDir: string, windowSize = '1440,900'): string[] {
  return [
    '--remote-debugging-pipe',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    // Closing the last window must not end the browser: the trace is still being handed over.
    '--keep-alive-for-test',
    `--window-size=${windowSize}`,
    'about:blank',
  ];
}

export function launchBrowser(options: LaunchOptions): LaunchedBrowser {
  const child = spawn(options.exe, browserArgs(options.profileDir, options.windowSize), {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
  const client = createCdpClient({
    output: child.stdio[3] as Writable,
    input: child.stdio[4] as Readable,
  });
  return { child, client, exited, kill: () => killTree(child) };
}
