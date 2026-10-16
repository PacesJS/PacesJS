// Original source text carried inside source maps (`sourcesContent`). The model does not keep it:
// it would double the size of every model for files the host can usually read from disk. The host
// calls this with the capture it already holds when a file is not on disk.

import type { ExecutionModel, StrId } from '../model.js';
import type { RawCapture } from '../raw.js';
import { decodeDataUri } from '../util/encoding.js';
import { normalizeSlashes, relativeToRoot, resolveSourcePath } from '../util/paths.js';

type Capture = Pick<RawCapture, 'tracks' | 'sourceMaps'>;

/** Model file path -> original text, built once per capture. */
const indexes = new WeakMap<object, Map<string, string>>();

interface MapJson {
  sources?: unknown;
  sourcesContent?: unknown;
  sourceRoot?: unknown;
}

function addMap(index: Map<string, string>, text: string, url: string, root: string): void {
  let parsed: MapJson;
  try {
    parsed = JSON.parse(text) as MapJson;
  } catch {
    return;
  }
  if (!Array.isArray(parsed.sources) || !Array.isArray(parsed.sourcesContent)) return;
  const sourceRoot = typeof parsed.sourceRoot === 'string' ? parsed.sourceRoot : '';
  parsed.sources.forEach((source: unknown, i) => {
    const content: unknown = (parsed.sourcesContent as unknown[])[i];
    if (typeof source !== 'string' || typeof content !== 'string') return;
    const key = relativeToRoot(resolveSourcePath(source, sourceRoot, url), root);
    if (!index.has(key)) index.set(key, content);
  });
}

function buildIndex(capture: Capture, root: string): Map<string, string> {
  const index = new Map<string, string>();
  const seen = new Set<string>();
  for (const [url, text] of Object.entries(capture.sourceMaps)) {
    seen.add(url);
    addMap(index, text, url, root);
  }
  for (const track of capture.tracks) {
    for (const script of track.scripts) {
      if (seen.has(script.url) || !script.sourceMapURL.startsWith('data:')) continue;
      seen.add(script.url);
      const text = decodeDataUri(script.sourceMapURL);
      if (text !== undefined) addMap(index, text, script.url, root);
    }
  }
  return index;
}

/**
 * The original text of `file` (a model file path or its string id) when a source map embeds it, else
 * `undefined`. The first call per capture parses the source maps; later calls are lookups.
 */
export function getEmbeddedSource(
  model: ExecutionModel,
  capture: Capture,
  file: StrId | string,
): string | undefined {
  const path = typeof file === 'number' ? model.strings[file] : file;
  if (!path) return undefined;
  let index = indexes.get(capture);
  if (!index) {
    index = buildIndex(capture, model.meta.projectRoot);
    indexes.set(capture, index);
  }
  return index.get(normalizeSlashes(path));
}
