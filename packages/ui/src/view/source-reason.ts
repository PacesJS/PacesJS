/** Why a function's source cannot be shown, and what to do about it. */

export type SourceReasonKind =
  'no-file' | 'outside-root' | 'not-on-disk' | 'map-missing' | 'no-lines';

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
  mapMissing: boolean;
  /** Lines with attributed time. */
  lineCount: number;
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
    return {
      kind: 'no-lines',
      title: 'No line-level time recorded',
      hint: 'The sampler saw this function but attributed no time to its lines, usually because it ran for less than one sampling interval.',
      showsText: true,
    };
  }
  return null;
}
