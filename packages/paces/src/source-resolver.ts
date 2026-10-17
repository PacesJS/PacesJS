import { readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from '@pacesjs/format';
import { guardSourcePath } from './source-guard.js';

export type SourceStatus = 'ok' | 'missing' | 'outside-root' | 'no-embedded-source';

export interface SourceResult {
  exists: boolean;
  text: string;
  hash: string;
  changedSinceProfile: boolean;
  status: SourceStatus;
  origin: 'disk' | 'embedded';
  /** Actionable text for the UI when there is no code to show. */
  hint: string;
}

export interface ResolverInput {
  projectRoot: string;
  /** URLs of every script V8 parsed during the run. */
  scriptUrls: Iterable<string>;
  /** Source map JSON keyed by the script URL it belongs to. */
  sourceMaps: Record<string, string>;
  /** `--embed-sources` copies by project-relative path. */
  embedded?: Map<string, Uint8Array>;
  /** Epoch ms the profile started, for the "changed since profiling" check. */
  startedAt: number;
}

export interface SourceResolver {
  resolve(requested: string): SourceResult;
  /** Real disk path an editor may open, or undefined. */
  diskPath(requested: string): string | undefined;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Comparable form of a path: '/' separators, no `..`, drive letters case-insensitive, no leading '/C:'. */
export function pathKey(input: string): string {
  let p = input;
  if (p.startsWith('file:')) {
    try {
      p = fileURLToPath(p);
    } catch {
      p = decodeURIComponent(p.replace(/^file:\/+/, '/'));
    }
  }
  p = p.replaceAll('\\', '/').replace(/^\/+([A-Za-z]:)/, '$1');
  p = p.replace(/^\/\/\?\//, '');
  const drive = /^[A-Za-z]:/.test(p);
  p = posix.normalize(p);
  return drive ? p.toLowerCase() : p;
}

const isAbsKey = (k: string): boolean => /^[a-z]:\//.test(k) || k.startsWith('/');

function cleanSourceName(src: string): string {
  return src.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\//i, '').replace(/^\.\//, '');
}

interface Embedded {
  text: string;
  /** The source map had no content for the file, so only its name is known. */
  missing?: boolean;
}

function indexSourceMaps(maps: Record<string, string>): Map<string, Embedded> {
  const out = new Map<string, Embedded>();
  for (const [scriptUrl, text] of Object.entries(maps)) {
    let map: { sources?: string[]; sourcesContent?: Array<string | null>; sourceRoot?: string };
    try {
      map = JSON.parse(text);
    } catch {
      continue;
    }
    const sources = map.sources ?? [];
    sources.forEach((src, i) => {
      const content = map.sourcesContent?.[i];
      const entry: Embedded =
        typeof content === 'string' ? { text: content } : { text: '', missing: true };
      const keys = new Set<string>();
      try {
        const root = map.sourceRoot ? map.sourceRoot.replace(/\/?$/, '/') : '';
        keys.add(pathKey(new URL(root + src, scriptUrl).href));
      } catch {
        // A script URL that is not a URL (eval) has no base to resolve against.
      }
      keys.add(pathKey(cleanSourceName(src)));
      for (const k of keys) {
        const prior = out.get(k);
        if (!prior || (prior.missing && !entry.missing)) out.set(k, entry);
      }
    });
  }
  return out;
}

/** Loaders add cache-busting queries (`eslint.config.js?mtime=...`); the file has no such name. */
function withoutQuery(raw: string): string {
  return raw.startsWith('file:') ? raw : raw.replace(/[?#].*$/, '');
}

const MOVED_HINT =
  'The file was not found on disk; it may have been moved or deleted since profiling. Profile with --embed-sources to keep a copy in the session.';

export function createSourceResolver(input: ResolverInput): SourceResolver {
  const rootKey = pathKey(input.projectRoot);
  const allowed = new Map<string, string>();
  for (const url of input.scriptUrls) {
    if (!url.startsWith('file:')) continue;
    try {
      allowed.set(pathKey(url), fileURLToPath(url));
    } catch {
      // Malformed URL in the capture: not allowlisted.
    }
  }
  const maps = indexSourceMaps(input.sourceMaps);
  const copies = new Map<string, Uint8Array>();
  for (const [rel, bytes] of input.embedded ?? []) copies.set(pathKey(`${rootKey}/${rel}`), bytes);

  const keysFor = (requested: string): string[] => {
    const k = pathKey(requested);
    if (isAbsKey(k)) return [k];
    return [pathKey(`${rootKey}/${requested}`), k];
  };

  const readDisk = (file: string): { bytes: Buffer; mtimeMs: number } | undefined => {
    try {
      const stat = statSync(file);
      return stat.isFile() ? { bytes: readFileSync(file), mtimeMs: stat.mtimeMs } : undefined;
    } catch {
      return undefined;
    }
  };

  /** A disk path we may read for this request: inside the root (realpath-checked) or a loaded script. */
  const allowedDisk = (requested: string, keys: string[]): string | undefined => {
    for (const k of keys) {
      const loaded = allowed.get(k);
      if (loaded) return loaded;
    }
    const guarded = guardSourcePath(input.projectRoot, requested);
    if (guarded && guarded !== 'missing') return guarded.path;
    return undefined;
  };

  const build = (
    status: SourceStatus,
    hint: string,
    extra: Partial<SourceResult> = {},
  ): SourceResult => ({
    exists: false,
    text: '',
    hash: '',
    changedSinceProfile: false,
    status,
    origin: 'disk',
    hint,
    ...extra,
  });

  return {
    diskPath(raw) {
      const requested = withoutQuery(raw);
      const keys = keysFor(requested);
      const file = allowedDisk(requested, keys);
      return file && readDisk(file) ? file : undefined;
    },
    resolve(raw) {
      const requested = withoutQuery(raw);
      if (!requested || requested.startsWith('node:')) {
        return build('missing', 'Built into Node.js, so there is no source file to show.');
      }
      const keys = keysFor(requested);
      const file = allowedDisk(requested, keys);
      const disk = file ? readDisk(file) : undefined;
      const embeddedMap = keys.map((k) => maps.get(k)).find((e): e is Embedded => e !== undefined);
      const copy = keys.map((k) => copies.get(k)).find((b): b is Uint8Array => b !== undefined);

      if (disk) {
        const hash = contentHash(disk.bytes);
        const profiled =
          copy ?? (embeddedMap && !embeddedMap.missing ? textBytes(embeddedMap.text) : undefined);
        const changed = profiled ? contentHash(profiled) !== hash : disk.mtimeMs > input.startedAt;
        return {
          exists: true,
          text: disk.bytes.toString('utf8'),
          hash,
          changedSinceProfile: changed,
          status: 'ok',
          origin: 'disk',
          hint: '',
        };
      }
      if (copy) {
        return build('ok', '', {
          exists: true,
          text: decoder.decode(copy),
          hash: contentHash(copy),
          origin: 'embedded',
        });
      }
      if (embeddedMap && !embeddedMap.missing) {
        const bytes = textBytes(embeddedMap.text);
        return build('ok', '', {
          exists: true,
          text: embeddedMap.text,
          hash: contentHash(bytes),
          origin: 'embedded',
        });
      }
      if (embeddedMap) {
        return build(
          'no-embedded-source',
          'This file comes from a source map that does not embed the original code (no sourcesContent) and the file is not on disk. Re-run with --embed-sources while the sources exist to keep a copy in the session.',
        );
      }
      const lexicallyInside = keys.some((k) => k === rootKey || k.startsWith(`${rootKey}/`));
      if (file || lexicallyInside) return build('missing', MOVED_HINT);
      return build(
        'outside-root',
        'This file is outside the profiled project and was not loaded by the profiled process, so paces will not read it.',
      );
    },
  };
}

function textBytes(text: string): Uint8Array {
  return encoder.encode(text);
}
