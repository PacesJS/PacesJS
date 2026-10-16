import { fmtDuration } from '../util/format';

/** Why a function's source cannot be shown, and what to do about it. */

export type SourceReasonKind =
  | 'no-file'
  | 'host-down'
  | 'outside-root'
  | 'not-on-disk'
  | 'map-missing'
  | 'no-self-time'
  | 'no-line-data';

export interface SourceReason {
  kind: SourceReasonKind;
  title: string;
  hint: string;
  /** True when the code is still shown and this is only a note above it. */
  showsText: boolean;
}

export interface SourceFacts {
  /** Project-relative path from the model, '' when the function has no file. */
  path: string;
  /** Did the host find the file (`undefined` while loading or when it refused). */
  exists: boolean | undefined;
  /** The host's error message when reading failed. */
  error: string | null;
  /** The request never reached the host (it stopped), as opposed to the host refusing the file. */
  hostDown?: boolean;
  mapMissing: boolean;
  /** Lines with attributed time. */
  lineCount: number;
  /** The function's own time in microseconds, when known. */
  selfUs?: number;
  /** Whether it called anything that took time. */
  hasCallees?: boolean;
  /** The engine's verdict on line time and its one-sentence reason, when known. */
  lineStatus?: 'self-lines' | 'no-self-time' | 'no-line-data';
  lineReason?: string;
}

const ABSOLUTE = /^([a-zA-Z]:[\\/]|\/|\\\\)/;
const SCHEME = /^(node:|file:|data:|internal\/|[a-z-]+:)/;

/** A path the host would not read: outside the project root, absolute, or not a file at all. */
export function isOutsideProject(path: string): boolean {
  return path.startsWith('..') || ABSOLUTE.test(path) || SCHEME.test(path);
}

/** `null` when the source text can be shown as it is. */
export function sourceReason(f: SourceFacts): SourceReason | null {
  if (!f.path) {
    return {
      kind: 'no-file',
      title: 'No source file',
      hint: 'This function is native or runtime code: it has no file to show. Its time is still counted in the views.',
      showsText: false,
    };
  }
  if (f.hostDown) {
    return {
      kind: 'host-down',
      title: 'Lost connection to the paces host',
      hint: 'The paces process that serves this window has stopped (it exits shortly after its window closes). Reopen the session with `paces open <file>`; nothing shown here is out of date until then, but source and settings cannot be read.',
      showsText: false,
    };
  }
  if (f.error !== null) {
    return {
      kind: 'outside-root',
      title: 'The host would not read this file',
      hint: `${f.error}. paces only reads files inside the project root that was recorded with the session; open the session from that project or move the file under it.`,
      showsText: false,
    };
  }
  if (isOutsideProject(f.path)) {
    return {
      kind: 'outside-root',
      title: 'Outside the project root',
      hint: 'paces only reads files inside the project root, so this one (runtime or dependency code) is not shown. Per-line time is still listed.',
      showsText: false,
    };
  }
  if (f.exists === false) {
    return {
      kind: 'not-on-disk',
      title: 'File not found on disk',
      hint: `${f.path} is not on disk. Open the session from the project that was profiled, or restore the file; per-line time is still listed.`,
      showsText: false,
    };
  }
  if (f.exists === true && f.mapMissing) {
    return {
      kind: 'map-missing',
      title: 'No source map: showing generated code',
      hint: 'The bundle has no source map, so names and lines are the generated ones. Build with source maps (for example esbuild --sourcemap) to see the original source.',
      showsText: true,
    };
  }
  if (f.exists === true && f.lineCount === 0) {
    if (f.lineStatus === 'no-self-time') {
      return {
        kind: 'no-self-time',
        title: 'Its time is in its callees',
        hint: `${f.lineReason ?? 'Its own time is tiny.'} Select a callee below to follow it.`,
        showsText: true,
      };
    }
    if (f.lineStatus === 'no-line-data') {
      return {
        kind: 'no-line-data',
        title: 'No line data for this function',
        hint: f.lineReason ?? 'V8 recorded no line positions for it.',
        showsText: true,
      };
    }
    if (f.hasCallees === true) {
      return {
        kind: 'no-self-time',
        title: 'Its time is in its callees',
        hint: `This function itself ran only ${fmtDuration(f.selfUs ?? 0)}; its time is in its callees, listed below. Select one to follow it.`,
        showsText: true,
      };
    }
    return {
      kind: 'no-line-data',
      title: 'No line data for this function',
      hint: 'V8 recorded no line ticks for it, so the gutter is empty. It is probably native code, was optimized away, or ran for less than one sampling interval.',
      showsText: true,
    };
  }
  return null;
}
