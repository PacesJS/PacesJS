// Pass 2: resolve every frame to its original file, line and name. Missing maps degrade to the
// generated position with a warning and a `mapMissing` flag; they never throw.

import { SourceMapConsumer } from 'source-map-js';
import type { RawCapture } from '../raw.js';
import { decodeDataUri } from '../util/encoding.js';
import { relativeToRoot, resolveSourcePath, urlToPath } from '../util/paths.js';
import type { IngestResult, PassContext } from './types.js';

export interface MappedFunctions {
  length: number;
  name: Uint32Array;
  file: Uint32Array;
  /** 1-based original line, 0 for native frames. */
  line: Uint32Array;
  col: Uint32Array;
  mapped: Uint8Array;
  mapMissing: Uint8Array;
}

export interface SourceMapResult {
  functions: MappedFunctions;
  /** Frame index -> function index. */
  frameToFn: Uint32Array;
  /** Per track, parallel to `RawTicks.line`: 1-based original line of each tick entry. */
  tickLines: Uint32Array[];
}

export interface SourceMapInput {
  capture: RawCapture;
  ingest: IngestResult;
}

interface MapEntry {
  consumer: SourceMapConsumer;
  sourceRoot: string;
}

type Lookup = MapEntry | 'missing' | 'none';

/** The source map of a script URL: supplied by the host, or embedded as a data URI. Cached per URL. */
function createLookup(capture: RawCapture, ctx: PassContext): (url: string) => Lookup {
  const root = capture.meta.projectRoot;
  const declared = new Map<string, string>();
  for (const track of capture.tracks) {
    for (const s of track.scripts) {
      if (s.sourceMapURL && !declared.has(s.url)) declared.set(s.url, s.sourceMapURL);
    }
  }
  const cache = new Map<string, Lookup>();
  return (url) => {
    const cached = cache.get(url);
    if (cached) return cached;
    let result: Lookup = 'none';
    const supplied = capture.sourceMaps[url];
    const ref = declared.get(url);
    let text = supplied;
    if (text === undefined && ref) text = decodeDataUri(ref);
    const pretty = relativeToRoot(urlToPath(url), root);
    if (text !== undefined) {
      try {
        const parsed = JSON.parse(text) as { sourceRoot?: string };
        result = {
          consumer: new SourceMapConsumer(
            parsed as ConstructorParameters<typeof SourceMapConsumer>[0],
          ),
          sourceRoot: parsed.sourceRoot ?? '',
        };
      } catch {
        ctx.warnings.push({ kind: 'source-map-invalid', severity: 'warn', detail: pretty });
        result = 'missing';
      }
    } else if (ref) {
      // Reported by `analyze` once classification knows whether the file is the target's or a dependency's.
      result = 'missing';
    }
    cache.set(url, result);
    return result;
  };
}

/** Per frame, what the tick-line mapping needs. */
interface FrameInfo {
  entry: MapEntry | undefined;
  source: string;
  fnLine: number;
}

/** Maps every frame to its original position and interns the functions (equal positions share a row). */
function mapFrames(
  ingest: IngestResult,
  lookup: (url: string) => Lookup,
  ctx: PassContext,
  root: string,
): { functions: MappedFunctions; frameToFn: Uint32Array; frameInfo: FrameInfo[] } {
  const strings = ctx.strings.strings;
  const frames = ingest.frames;
  const frameToFn = new Uint32Array(frames.length);
  const fnIndex = new Map<string, number>();
  const name: number[] = [];
  const file: number[] = [];
  const line: number[] = [];
  const col: number[] = [];
  const mapped: number[] = [];
  const mapMissing: number[] = [];
  const frameInfo: FrameInfo[] = [];

  for (let f = 0; f < frames.length; f++) {
    const url = strings[frames.url[f] ?? 0] ?? '';
    const fnName = strings[frames.name[f] ?? 0] ?? '';
    const genLine = frames.line[f] ?? -1;
    const genCol = frames.col[f] ?? -1;
    let filePath = url.startsWith('file:') ? relativeToRoot(urlToPath(url), root) : url;
    let origLine = genLine >= 0 ? genLine + 1 : 0;
    let origCol = genCol >= 0 ? genCol : 0;
    let origName = fnName;
    let isMapped = 0;
    let isMissing = 0;
    let entry: MapEntry | undefined;
    let sourcePath = filePath;

    const found = url && genLine >= 0 ? lookup(url) : 'none';
    if (found === 'missing') isMissing = 1;
    else if (found !== 'none') {
      entry = found;
      let pos = found.consumer.originalPositionFor({
        line: genLine + 1,
        column: Math.max(0, genCol),
        bias: SourceMapConsumer.GREATEST_LOWER_BOUND,
      });
      if (pos.source === null) {
        pos = found.consumer.originalPositionFor({
          line: genLine + 1,
          column: Math.max(0, genCol),
          bias: SourceMapConsumer.LEAST_UPPER_BOUND,
        });
      }
      if (pos.source !== null && pos.line !== null) {
        sourcePath = resolveSourcePath(pos.source, found.sourceRoot, url);
        filePath = relativeToRoot(sourcePath, root);
        origLine = pos.line;
        origCol = pos.column ?? 0;
        if (pos.name && (fnName === '' || fnName.length <= 2)) origName = pos.name;
        isMapped = 1;
      }
    }

    const nameId = ctx.strings.intern(origName);
    const fileId = ctx.strings.intern(filePath);
    const key = `${nameId}|${fileId}|${origLine}|${origCol}`;
    let fn = fnIndex.get(key);
    if (fn === undefined) {
      fn = name.length;
      fnIndex.set(key, fn);
      name.push(nameId);
      file.push(fileId);
      line.push(origLine);
      col.push(origCol);
      mapped.push(isMapped);
      mapMissing.push(isMissing);
    } else {
      if (isMapped) mapped[fn] = 1;
      if (isMissing) mapMissing[fn] = 1;
    }
    frameToFn[f] = fn;
    frameInfo[f] = { entry: isMapped ? entry : undefined, source: sourcePath, fnLine: origLine };
  }

  return {
    functions: {
      length: name.length,
      name: Uint32Array.from(name),
      file: Uint32Array.from(file),
      line: Uint32Array.from(line),
      col: Uint32Array.from(col),
      mapped: Uint8Array.from(mapped),
      mapMissing: Uint8Array.from(mapMissing),
    },
    frameToFn,
    frameInfo,
  };
}

/** The original line of every line-tick entry, per track. */
function mapTickLines(
  ingest: IngestResult,
  frameInfo: FrameInfo[],
  strings: string[],
): Uint32Array[] {
  const frames = ingest.frames;
  return ingest.tracks.map((track) => {
    const out = new Uint32Array(track.ticks.line.length);
    for (let n = 0; n < track.tree.length; n++) {
      const frame = track.tree.frame[n] ?? 0;
      const info = frameInfo[frame];
      const genStart = (frames.line[frame] ?? 0) + 1;
      for (let i = track.ticks.offset[n] ?? 0; i < (track.ticks.offset[n + 1] ?? 0); i++) {
        const g = track.ticks.line[i] ?? 0;
        let resolved = g;
        if (info?.entry) {
          const pos = info.entry.consumer.originalPositionFor({
            line: g,
            column: 0,
            bias: SourceMapConsumer.LEAST_UPPER_BOUND,
          });
          const url = strings[frames.url[frame] ?? 0] ?? '';
          const sameFile =
            pos.source !== null &&
            resolveSourcePath(pos.source, info.entry.sourceRoot, url) === info.source;
          resolved =
            pos.line !== null && sameFile ? pos.line : Math.max(1, info.fnLine + (g - genStart));
        }
        out[i] = resolved;
      }
    }
    return out;
  });
}

export function resolveSourceMaps(input: SourceMapInput, ctx: PassContext): SourceMapResult {
  const { capture, ingest } = input;
  const lookup = createLookup(capture, ctx);
  const { functions, frameToFn, frameInfo } = mapFrames(
    ingest,
    lookup,
    ctx,
    capture.meta.projectRoot,
  );
  return {
    functions,
    frameToFn,
    tickLines: mapTickLines(ingest, frameInfo, ctx.strings.strings),
  };
}
