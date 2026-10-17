import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { which } from './which.js';

type Env = Record<string, string | undefined>;

export interface Launch {
  file: string;
  args: string[];
  shell?: boolean;
}

// Characters cmd.exe would interpret; a path with any of them never goes through a shell.
const SHELL_META = /[&|<>^%!"'`$;()\r\n]/;

/** `code -g file:line` when VS Code is on PATH, otherwise the OS default handler. */
export function planEditorOpen(
  file: string,
  line: number,
  env: Env = process.env,
  platform: string = process.platform,
  exists?: (p: string) => boolean,
): Launch {
  if (!Number.isInteger(line) || line < 1) line = 1;
  const code = SHELL_META.test(file) ? undefined : which('code', env, platform, exists);
  if (code) {
    const target = `${file}:${line}`;
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(code)) {
      return { file: `"${code}"`, args: ['-g', `"${target}"`], shell: true };
    }
    return { file: code, args: ['-g', target] };
  }
  return osOpen(file, platform);
}

/** The OS "open this" command for a file or URL. No shell is involved. */
export function osOpen(target: string, platform: string = process.platform): Launch {
  if (platform === 'win32')
    return { file: 'rundll32', args: ['url.dll,FileProtocolHandler', target] };
  if (platform === 'darwin') return { file: 'open', args: [target] };
  return { file: 'xdg-open', args: [target] };
}

export function run(plan: Launch): ChildProcess {
  const child = spawn(plan.file, plan.args, {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
    ...(plan.shell ? { shell: true } : {}),
  });
  child.on('error', () => {});
  child.unref();
  return child;
}

export interface BrowserLookup {
  env?: Env;
  platform?: string;
  exists?: (p: string) => boolean;
}

/** Edge, then Chrome, then Chromium. Windows install paths only, no registry. */
export function findBrowser(opts: BrowserLookup = {}): string | undefined {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  const candidates: string[] = [];
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA, env.ProgramW6432]
      .filter((r): r is string => Boolean(r))
      .concat(['C:\\Program Files', 'C:\\Program Files (x86)']);
    const unique = [...new Set(roots)];
    const rel = [
      'Microsoft\\Edge\\Application\\msedge.exe',
      'Google\\Chrome\\Application\\chrome.exe',
      'Chromium\\Application\\chrome.exe',
    ];
    for (const r of rel) for (const root of unique) candidates.push(`${root}\\${r}`);
  } else if (platform === 'darwin') {
    const apps = [
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Chromium.app/Contents/MacOS/Chromium',
    ];
    for (const a of apps) candidates.push(`/Applications/${a}`, join(homedir(), 'Applications', a));
  } else {
    for (const n of [
      'microsoft-edge',
      'microsoft-edge-stable',
      'google-chrome',
      'google-chrome-stable',
      'chromium',
      'chromium-browser',
    ]) {
      const found = which(n, env, platform);
      if (found) candidates.push(found);
    }
  }
  return candidates.find((c) => exists(c));
}

/** True when there is no display to open a window on, or we are inside an SSH session. */
export function isHeadless(env: Env = process.env, platform: string = process.platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return true;
  if (platform === 'linux') return !env.DISPLAY && !env.WAYLAND_DISPLAY;
  return false;
}

export function appModeArgs(url: string, profileDir: string): string[] {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
  ];
}

/** Ends a process and everything it started. On Windows `child.kill()` only ends the root. */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else child.kill('SIGKILL');
}

/** Removes a directory a browser may still be releasing; never throws. */
export function removeQuietly(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // A leftover temp profile is harmless; a crash on exit is not.
  }
}
