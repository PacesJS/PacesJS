// Shared shapes between passes. Every pass is `(input, ctx) => output`.

import type { AnalyzeOptions, Thresholds } from '../config.js';
import type {
  EventTable,
  ExecutionModel,
  Finding,
  OriginId,
  RunKind,
  Samples,
  TrackRole,
} from '../model.js';
import type { RawCapture, ScriptInfo, TimelineEvent, TrackInfo } from '../raw.js';
import type { StringTable } from '../util/strings.js';

/** One occurrence of something worth a warning; `analyze` folds drafts into one `ModelWarning` per kind. */
export interface WarningDraft {
  kind: string;
  severity: 'info' | 'warn';
  /** What it was about: a file path, a pattern, a track id. */
  detail: string;
}

/** Which functions are first-party because they belong to the profiled program. */
export interface TargetSpec {
  /** npm package names whose functions are user code. */
  packages: Set<string>;
  /** Path globs (as regular expressions) tested against the stored file path. */
  globs: RegExp[];
  /** Browser runs: code is first-party when it comes from the site the run started on. */
  browser?: { launchedUrl: string; firstParty: string[]; appSites: string[] };
}

export interface PassContext {
  /** What differs between kinds of run: chosen once from the capture. */
  run: RunAdapter;
  thresholds: Thresholds;
  options: AnalyzeOptions;
  strings: StringTable;
  warnings: WarningDraft[];
  /** Set once the target is known; passes before that (ingest, source maps) leave it undefined. */
  target?: TargetSpec;
}

/** Distinct (name, url, line, column) tuples across all tracks, before source mapping. */
export interface FrameTable {
  length: number;
  name: Uint32Array;
  url: Uint32Array;
  /** 0-based as V8 reports it; -1 for native frames. */
  line: Int32Array;
  col: Int32Array;
}

/** Raw call tree in preorder (node 0 is `(root)`); `frame` indexes `FrameTable`. */
export interface RawTree {
  length: number;
  parent: Int32Array;
  frame: Uint32Array;
  depth: Uint16Array;
  subtreeEnd: Uint32Array;
  self: Float64Array;
  total: Float64Array;
  /** Samples that landed exactly on this node. */
  hits: Uint32Array;
}

/** V8 `positionTicks` in CSR layout per node: entries of node n are [offset[n], offset[n+1]). */
export interface RawTicks {
  offset: Uint32Array;
  /** 1-based generated line. */
  line: Uint32Array;
  ticks: Uint32Array;
}

export interface AsyncRecords {
  length: number;
  /** Microseconds since `meta.startedAt`. */
  time: Float64Array;
  /** 0 init, 1 before, 2 after, 3 destroy. */
  phase: Uint8Array;
  asyncId: Float64Array;
  triggerAsyncId: Float64Array;
}

export interface IngestedTrack {
  info: TrackInfo;
  tree: RawTree;
  samples: Samples;
  ticks: RawTicks;
  events: EventTable;
  async: AsyncRecords;
  scripts: ScriptInfo[];
  /** Browser traces: exact events of this thread, on the trace clock. */
  timeline?: TimelineEvent[];
}

export interface IngestResult {
  frames: FrameTable;
  tracks: IngestedTrack[];
  /** Measured sampling interval (microseconds): the larger of the configured and the median gap. */
  precisionUs: number;
  durationUs: number;
  /** The monotonic clock reading that corresponds to `meta.startedAt`. */
  monoAtStartUs: number;
}

export interface TargetDetection {
  /** Absolute entry script per track ('' when unknown), '/'-separated. */
  entryAbs: string[];
  /** Entry per track in model form: project-relative inside the root, absolute outside. */
  entries: string[];
  roles: TrackRole[];
  primary: number;
  spec: TargetSpec;
  /** Package names reported in `ExecutionModel.target.packages`. */
  packages: string[];
  /** The primary process is a command: its entry is in node_modules or it has arguments. */
  commandLike: boolean;
}

export type FindingRule = (model: ExecutionModel, th: Thresholds) => Finding[];

export interface FrameFacts {
  name: string;
  file: string;
  line: number;
}

export interface ClassifiedFunction {
  origin: OriginId;
  /** Package or host the function belongs to; '' for none. */
  pkg: string;
}

/**
 * The parts of an analysis that depend on what was profiled. A capture picks one adapter once, and the
 * passes call it, so no pass asks "is this a browser?". Adding a kind of run adds an adapter.
 */
export interface RunAdapter {
  /** The kind of run, when how it was captured already says (a page); otherwise it is worked out. */
  fixedRunKind?: RunKind;
  /** Which track is the program, and what counts as its own code. */
  detectTarget(capture: RawCapture, ingest: IngestResult, ctx: PassContext): TargetDetection;
  /** The origin of one function. `forced` is a caller's override, which wins over the rules. */
  classifyFunction(
    frame: FrameFacts,
    target: TargetSpec | undefined,
    forced: OriginId | undefined,
  ): ClassifiedFunction;
  /** The finding rules that apply to this kind of run. */
  rules: readonly FindingRule[];
}
