import type { RawCapture } from '@pacesjs/engine';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { ZipOptions } from 'fflate';
import { captureToFiles, filesToCapture } from './files.js';
import { contentHash } from './hash.js';
import type { Manifest } from './manifest.js';
import { SessionFormatError, assertReadable } from './manifest.js';

export interface WriteOptions {
  engineVersion: string;
  /** Serialized execution model to cache as `model/<engineVersion>.bin`. */
  model?: Uint8Array;
  /** Source files to embed (`--embed-sources`), stored by content hash. */
  sources?: Array<{ path: string; content: Uint8Array }>;
}

export interface ReadOptions {
  /** Only a cache written by this engine version is returned. */
  engineVersion?: string;
}

export interface Session {
  manifest: Manifest;
  capture: RawCapture;
  /** Cached model bytes, present only when written by `ReadOptions.engineVersion`. */
  model?: Uint8Array;
  /** Embedded sources by content hash. */
  sources: Record<string, Uint8Array>;
}

// Fixed timestamp: identical input gives identical bytes.
const MTIME = Date.UTC(2000, 0, 1);
const entry = (data: Uint8Array, level: ZipOptions['level'] = 6): [Uint8Array, ZipOptions] => [
  data,
  { level, mtime: MTIME },
];

export function writeSession(capture: RawCapture, options: WriteOptions): Uint8Array {
  const { manifest, files } = captureToFiles(capture, options.engineVersion);
  const zip: Record<string, [Uint8Array, ZipOptions]> = {};
  for (const [name, data] of Object.entries(files)) zip[name] = entry(data);
  for (const s of options.sources ?? []) {
    const hash = contentHash(s.content);
    zip[`sources/${hash}`] = entry(s.content);
    manifest.sources.push({ path: s.path.replaceAll('\\', '/'), hash });
  }
  if (options.model) {
    manifest.model = `model/${options.engineVersion}.bin`;
    zip[manifest.model] = entry(options.model, 1);
  }
  zip['manifest.json'] = entry(strToU8(JSON.stringify(manifest, null, 2)));
  return zipSync(zip);
}

function readFiles(bytes: Uint8Array): { manifest: Manifest; files: Record<string, Uint8Array> } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new SessionFormatError(
      'This is not a .paces session (it is not a valid zip). Open a file written by `paces`.',
    );
  }
  const raw = files['manifest.json'];
  if (!raw) throw new SessionFormatError('The session has no manifest.json; it may be damaged.');
  let manifest: Manifest;
  try {
    manifest = JSON.parse(strFromU8(raw)) as Manifest;
  } catch {
    throw new SessionFormatError('manifest.json is not valid JSON; the session may be damaged.');
  }
  assertReadable(manifest.formatVersion);
  return { manifest, files };
}

export function readManifest(bytes: Uint8Array): Manifest {
  const { manifest } = readFiles(bytes);
  return { ...manifest, sources: manifest.sources ?? [] };
}

export function readSession(bytes: Uint8Array, options: ReadOptions = {}): Session {
  const { manifest, files } = readFiles(bytes);
  const sources: Record<string, Uint8Array> = {};
  for (const s of manifest.sources ?? []) {
    const data = files[`sources/${s.hash}`];
    if (data) sources[s.hash] = data;
  }
  const modelName =
    options.engineVersion !== undefined ? `model/${options.engineVersion}.bin` : undefined;
  const model = modelName ? files[modelName] : undefined;
  return {
    manifest: { ...manifest, sources: manifest.sources ?? [] },
    capture: filesToCapture(files, manifest),
    ...(model ? { model } : {}),
    sources,
  };
}
