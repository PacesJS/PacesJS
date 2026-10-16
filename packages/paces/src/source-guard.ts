import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Guarded {
  /** Absolute, realpath-resolved path inside the root. */
  path: string;
}

const win = process.platform === 'win32';
const norm = (p: string): string => (win ? p.toLowerCase() : p);

function inside(root: string, p: string): boolean {
  const r = norm(root.endsWith(sep) ? root : root + sep);
  return norm(p) === norm(root) || norm(p).startsWith(r);
}

/** Windows-only forms that escape a root even though they look relative or odd. */
function suspicious(raw: string): boolean {
  if (raw.includes('\0')) return true;
  if (win && (/^\\\\/.test(raw) || /^\/\//.test(raw))) return true; // UNC, \\?\ device paths
  if (win && /^[a-z]:(?![\\/])/i.test(raw)) return true; // drive-relative: C:foo
  return false;
}

/**
 * Resolves a project-relative path or file URL to a real path inside `projectRoot`, or `undefined`.
 * The lexical check runs first, then again after `realpath`, which defeats symlinks and junctions.
 * Returns `{ path }` or `'missing'` for an allowed path that does not exist.
 */
export function guardSourcePath(
  projectRoot: string,
  requested: string,
): Guarded | 'missing' | undefined {
  let raw = requested;
  try {
    if (raw.startsWith('file:')) raw = fileURLToPath(raw);
  } catch {
    return undefined;
  }
  if (!raw || suspicious(raw)) return undefined;

  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(projectRoot));
  } catch {
    return undefined;
  }
  const lexical = isAbsolute(raw) ? resolve(raw) : resolve(realRoot, raw);
  if (!inside(realRoot, lexical) && !inside(resolve(projectRoot), lexical)) return undefined;

  let real: string;
  try {
    real = realpathSync(lexical);
  } catch {
    // Not on disk: allowed only if the path itself stays inside the root.
    return inside(realRoot, lexical) || inside(resolve(projectRoot), lexical)
      ? 'missing'
      : undefined;
  }
  return inside(realRoot, real) ? { path: real } : undefined;
}
