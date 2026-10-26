import { win32 } from 'node:path';
import { which } from '@pacesjs/shared';

export interface SpawnPlan {
  file: string;
  args: string[];
  /** Pass the arguments to CreateProcess as given: the single command line is already quoted. */
  verbatim: boolean;
}

const META = /[()%!^"<>&|]/g;

/**
 * Quotes one argument for a command line that cmd.exe will parse (the algorithm cross-spawn uses).
 * `doubleEscape` is for `.cmd` shims, which pass `%*` through cmd a second time.
 */
export function quoteCmdArg(arg: string, doubleEscape = false): string {
  let out = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  out = `"${out}"`;
  out = out.replace(META, '^$&');
  if (doubleEscape) out = out.replace(META, '^$&');
  return out;
}

/**
 * Windows cannot spawn `.cmd`/`.bat` shims (npm, npx, tsx...) directly, and `shell: true` with an
 * arguments array is deprecated (DEP0190). Run them through one explicitly quoted `cmd.exe /d /s /c`
 * line instead. Everything else is spawned directly with arguments untouched.
 */
export function planSpawn(
  command: string[],
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  exists?: (p: string) => boolean,
): SpawnPlan {
  const [file = '', ...args] = command;
  if (platform !== 'win32') return { file, args, verbatim: false };
  const resolved = which(file, env, platform, exists) ?? file;
  const ext = win32.extname(resolved).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    const line = [`"${resolved}"`, ...args.map((a) => quoteCmdArg(a, true))].join(' ');
    // cmd /s strips the outer quotes, so the whole line is wrapped once more.
    return {
      file: env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      verbatim: true,
    };
  }
  return { file, args, verbatim: false };
}
