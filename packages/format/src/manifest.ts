import type { CaptureMeta, TrackInfo } from '@pacesjs/engine';

/** Semver of the file layout. Bump the minor for additive changes, the major for breaking ones. */
export const FORMAT_VERSION = '1.0.0';

export interface SourceEntry {
  /** Project-relative path with forward slashes. */
  path: string;
  /** `contentHash` of the embedded text. */
  hash: string;
}

export interface Manifest {
  formatVersion: string;
  engineVersion: string;
  command: string[];
  cwd: string;
  nodeVersion: string;
  platform: string;
  mode: CaptureMeta['mode'];
  intervalUs: number;
  startedAt: number;
  endedAt: number;
  endedBy: CaptureMeta['endedBy'];
  projectRoot: string;
  tracks: TrackInfo[];
  sources: SourceEntry[];
  /** Processes and workers stopped before they could write a profile; absent in older sessions. */
  lostTracks?: NonNullable<CaptureMeta['lostTracks']>;
  /** Marks the user added while profiling; absent in older sessions and runs without any. */
  marks?: NonNullable<CaptureMeta['marks']>;
  /** Model cache entry, if one was written. */
  model?: string;
}

export class FormatVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormatVersionError';
  }
}

export class SessionFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionFormatError';
  }
}

function major(version: string): number | undefined {
  const m = /^(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(version);
  return m ? Number(m[1]) : undefined;
}

/** Readers accept any minor of their major; anything else is refused with an actionable message. */
export function assertReadable(version: unknown): void {
  const mine = major(FORMAT_VERSION) as number;
  const theirs = typeof version === 'string' ? major(version) : undefined;
  if (theirs === undefined) {
    throw new FormatVersionError(
      `This session has an invalid formatVersion (${JSON.stringify(version)}). The file may be damaged; re-run the profile.`,
    );
  }
  if (theirs > mine) {
    throw new FormatVersionError(
      `This session uses format ${String(version)}, newer than this paces understands (${FORMAT_VERSION}). Please upgrade paces: npm i -g paces@latest.`,
    );
  }
  if (theirs < mine) {
    throw new FormatVersionError(
      `This session uses the old format ${String(version)}, which this paces (${FORMAT_VERSION}) can no longer read. Open it with the older paces that wrote it, or re-run the profile.`,
    );
  }
}
