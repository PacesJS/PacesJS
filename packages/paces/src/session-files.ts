import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawCapture } from '@pacesjs/engine';

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** `20261016-142233`: sortable, and free of `:` which Windows forbids in file names. */
export function timestampName(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** `./.paces/<time>.paces`, with a numeric suffix if two runs land in the same second. */
export function defaultSessionPath(
  cwd: string,
  now: Date = new Date(),
  exists: (p: string) => boolean = existsSync,
  suffix = '',
): string {
  const stem = `${timestampName(now)}${suffix}`;
  let candidate = join(cwd, '.paces', `${stem}.paces`);
  for (let n = 2; exists(candidate); n++) candidate = join(cwd, '.paces', `${stem}-${n}.paces`);
  return candidate;
}

export function writeSessionFile(file: string, bytes: Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

/** Nearest ancestor with a package.json or .git, else the start directory. */
export function findProjectRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'package.json')) || existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

function toPath(url: string): string | undefined {
  try {
    if (url.startsWith('file:')) return fileURLToPath(url);
    return isAbsolute(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Project source files (and the originals named by source maps) worth embedding with `--embed-sources`. */
export function collectSources(
  capture: RawCapture,
  limitBytes = 25 * 1024 * 1024,
): Array<{ path: string; content: Uint8Array }> {
  const root = resolve(capture.meta.projectRoot);
  const found = new Map<string, Uint8Array>();
  let total = 0;
  const add = (abs: string): void => {
    const rel = relative(root, abs).replaceAll('\\', '/');
    if (rel.startsWith('..') || isAbsolute(rel) || rel.includes('node_modules/')) return;
    if (found.has(rel)) return;
    try {
      if (!statSync(abs).isFile()) return;
      const bytes = readFileSync(abs);
      if (total + bytes.length > limitBytes) return;
      total += bytes.length;
      found.set(rel, bytes);
    } catch {
      // A file that vanished is simply not embedded.
    }
  };
  const urls = new Set<string>();
  for (const t of capture.tracks) for (const s of t.scripts) urls.add(s.url);
  for (const url of urls) {
    const abs = toPath(url);
    if (abs) add(abs);
  }
  for (const [url, mapText] of Object.entries(capture.sourceMaps)) {
    const abs = toPath(url);
    if (abs) add(`${abs}.map`);
    try {
      const map = JSON.parse(mapText) as { sources?: string[]; sourceRoot?: string };
      for (const src of map.sources ?? []) {
        const base = abs ? dirname(abs) : root;
        const original = resolve(base, map.sourceRoot ?? '', src.replace(/^file:\/\/\/?/, ''));
        add(original);
      }
    } catch {
      // Malformed map: the engine already warned about it.
    }
  }
  return [...found.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, content]) => ({ path, content }));
}
