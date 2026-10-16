import { existsSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

type Env = Record<string, string | undefined>;

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Finds an executable on PATH, honoring PATHEXT on Windows. Returns the full path or undefined. */
export function which(
  name: string,
  env: Env = process.env,
  platform: string = process.platform,
  exists: (p: string) => boolean = isFile,
): string | undefined {
  const win = platform === 'win32';
  const { join, extname, delimiter } = win ? win32 : posix;
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const dirs = (env[pathKey] ?? '').split(win ? ';' : delimiter).filter(Boolean);
  const exts = win ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const hasExt = win && extname(name) !== '';
  const candidates = (dir: string): string[] =>
    hasExt || !win
      ? [join(dir, name)]
      : [
          ...exts.map((e) => join(dir, name + e.toLowerCase())),
          ...exts.map((e) => join(dir, name + e)),
        ];
  if (name.includes('/') || name.includes('\\')) {
    const direct = candidates('')[0] ?? name;
    return exists(name) ? name : exists(direct) ? direct : undefined;
  }
  for (const dir of dirs) {
    for (const c of candidates(dir)) if (exists(c)) return c;
  }
  return undefined;
}

export const pathExists = existsSync;
