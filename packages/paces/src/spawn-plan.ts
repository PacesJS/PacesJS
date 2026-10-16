import { posix, win32 } from 'node:path';
import { which } from './which.js';

export interface SpawnPlan {
  file: string;
  args: string[];
  shell: boolean;
}

/** Quotes one argument for a cmd.exe command line. Best effort: `%VAR%` cannot be escaped reliably. */
export function quoteCmdArg(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s&|<>()^"%!,;=]/.test(arg)) return arg;
  return `"${arg.replaceAll('"', '\\"')}"`;
}

/**
 * Windows cannot spawn `.cmd` shims (npm, npx, tsx...) without a shell since Node 20.12, and a shell
 * needs a pre-quoted command line. Everything else is spawned directly with arguments untouched.
 */
export function planSpawn(
  command: string[],
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  exists?: (p: string) => boolean,
): SpawnPlan {
  const [file = '', ...args] = command;
  if (platform !== 'win32') return { file, args, shell: false };
  const resolved = which(file, env, platform, exists) ?? file;
  const ext = (platform === 'win32' ? win32 : posix).extname(resolved).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    return { file: quoteCmdArg(resolved), args: args.map(quoteCmdArg), shell: true };
  }
  return { file, args, shell: false };
}
