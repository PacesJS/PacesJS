// Path helpers. Everything the engine stores is '/'-separated.

export function normalizeSlashes(path: string): string {
  return path.replaceAll('\\', '/');
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const DRIVE = /^[A-Za-z]:\//;

/** `file:///C:/x/y.js` -> `C:/x/y.js`, `file:///project/x.js` -> `/project/x.js`; other URLs unchanged. */
export function urlToPath(url: string): string {
  if (!url.startsWith('file:')) return normalizeSlashes(url);
  let path = url.slice('file://'.length);
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw text
  }
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return normalizeSlashes(path);
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || DRIVE.test(path);
}

/** Resolves `.` and `..` segments of a '/'-separated path. */
export function collapseDots(path: string): string {
  const prefix = DRIVE.test(path) ? path.slice(0, 3) : path.startsWith('/') ? '/' : '';
  const out: string[] = [];
  for (const part of path.slice(prefix.length).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!prefix) out.push('..');
    } else out.push(part);
  }
  return prefix + out.join('/');
}

export function dirnameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Path relative to `root` when inside it; otherwise the normalized path. */
export function relativeToRoot(path: string, root: string): string {
  const r = normalizeSlashes(root).replace(/\/+$/, '');
  if (!r || !isAbsolutePath(path)) return path;
  const caseless = /^[A-Za-z]:/.test(r);
  const a = caseless ? path.toLowerCase() : path;
  const b = caseless ? r.toLowerCase() : r;
  if (a === b) return '';
  if (a.startsWith(`${b}/`)) return path.slice(r.length + 1);
  return path;
}

/** npm package name of the innermost `node_modules` segment, or '' when there is none. */
export function packageNameFromPath(path: string): string {
  const marker = 'node_modules/';
  const at = path.lastIndexOf(marker);
  if (at < 0) return '';
  const rest = path.slice(at + marker.length).split('/');
  const first = rest[0] ?? '';
  if (first.startsWith('@')) return rest[1] ? `${first}/${rest[1]}` : first;
  return first;
}

/**
 * Resolves a source-map `sources` entry against the map's owner (the script URL) and `sourceRoot`.
 * `webpack://ns/./src/a.ts` becomes `src/a.ts`.
 */
export function resolveSourcePath(source: string, sourceRoot: string, scriptUrl: string): string {
  let src = source;
  if (sourceRoot && !SCHEME.test(src) && !src.startsWith('/')) {
    src = `${sourceRoot.replace(/\/+$/, '')}/${src}`;
  }
  const webpack = /^webpack(?:-internal)?:\/\/[^/]*\/(.*)$/.exec(src);
  if (webpack) return collapseDots((webpack[1] ?? '').replace(/^\(webpack\)\//, ''));
  if (SCHEME.test(src) && !/^[A-Za-z]:[\\/]/.test(src)) {
    return src.startsWith('file:') ? urlToPath(src) : src;
  }
  const normalized = normalizeSlashes(src);
  if (isAbsolutePath(normalized)) return collapseDots(normalized);
  const base = dirnameOf(urlToPath(scriptUrl));
  return collapseDots(`${base}/${normalized}`);
}

export function basenameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** `.../node_modules/.pnpm/x@1/node_modules/x/lib/y.js` -> `x/lib/y.js`; other paths are unchanged. */
export function displayPath(path: string): string {
  const marker = 'node_modules/';
  const at = path.lastIndexOf(marker);
  return at < 0 ? path : path.slice(at + marker.length);
}

/** paces' own preload scripts, as installed (paces, @pacesjs/collector-node) or built in the monorepo. */
const INSTRUMENTATION =
  /(^|\/)(paces|collector-node|@pacesjs\/collector-node)\/dist\/preload\.cjs$/;

export function isPacesInstrumentation(path: string): boolean {
  return INSTRUMENTATION.test(path);
}

/** `**` crosses directories, `*` and `?` stay inside one; the whole path must match. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  const g = normalizeSlashes(glob);
  for (let i = 0; i < g.length; i++) {
    const c = g[i] ?? '';
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** True when a `focus` entry is a path glob rather than a package name. */
export function isGlob(entry: string): boolean {
  return (
    /[*?]/.test(entry) || (entry.includes('/') && !entry.startsWith('@')) || entry.includes('\\')
  );
}
