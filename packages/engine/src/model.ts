// The execution model: one columnar, serializable projection of a capture.
// All times are microseconds relative to `meta.startedAt` unless a name says otherwise.

import type { CaptureMeta, TrackId, TrackKind } from './raw.js';

/** Index into `ExecutionModel.strings`. 0 is always the empty string. */
export type StrId = number;
export type FnId = number;
export type NodeId = number;

export const Origin = {
  User: 0,
  Dependency: 1,
  Framework: 2,
  Node: 3,
  Native: 4,
  Idle: 5,
  Gc: 6,
} as const;
export type OriginId = (typeof Origin)[keyof typeof Origin];
export const ORIGIN_NAMES = [
  'user',
  'dependency',
  'framework',
  'node',
  'native',
  'idle',
  'gc',
] as const;

export const TaskKind = {
  Main: 0,
  Request: 1,
  Timer: 2,
  Immediate: 3,
  Microtask: 4,
  Io: 5,
  Other: 6,
} as const;
export type TaskKindId = (typeof TaskKind)[keyof typeof TaskKind];
export const TASK_KIND_NAMES = [
  'main',
  'request',
  'timer',
  'immediate',
  'microtask',
  'io',
  'other',
] as const;

/** What the profiled program is: a long-running server, a command-line tool, or a plain script. */
export type RunKind = 'server' | 'cli' | 'script';

/** One aggregated warning per `kind`: never one entry per file. */
export interface ModelWarning {
  kind: string;
  /** 'warn' needs attention (e.g. a missing source map in the target's own code); 'info' is expected. */
  severity: 'info' | 'warn';
  summary: string;
  /** Number of occurrences the summary stands for. */
  count: number;
  /** Up to 20 samples (file paths, patterns, track ids). */
  details: string[];
}

export interface SessionMeta extends CaptureMeta {
  /** ± measurement precision in microseconds (one sampling interval). */
  precisionUs: number;
  /** Whole-run duration in microseconds. */
  durationUs: number;
  engineVersion: string;
  /** Aggregated warnings raised by passes, at most one per kind. */
  warnings: ModelWarning[];
  /** `server` when request events or a listening server were seen, else `cli` or `script`. */
  runKind: RunKind;
}

/** One row per distinct function (after source mapping). */
export interface FunctionTable {
  length: number;
  name: Uint32Array;
  file: Uint32Array;
  /** 1-based original line. */
  line: Uint32Array;
  col: Uint32Array;
  origin: Uint8Array;
  /** npm package name for dependencies, 0 for user code. */
  pkg: Uint32Array;
  /** 1 = async or framework plumbing, folded by default. */
  plumbing: Uint8Array;
  /** 1 = a source map was applied to this function's position. */
  mapped: Uint8Array;
  /** 1 = a source map was expected but missing. */
  mapMissing: Uint8Array;
  /** 1 = module loading: a loader frame (require, Module._load, ...) or a module's top-level function. */
  loader: Uint8Array;
}

/**
 * What V8 reported when it threw away optimized code (--v8 runs only; empty otherwise). One row per
 * function, reason and source position, with how often it happened.
 */
export interface DeoptTable {
  length: number;
  fn: Uint32Array;
  /** String table index of V8's reason, e.g. "wrong map". */
  reason: Uint32Array;
  /** 0 eager (the code's own assumption failed), 1 lazy (something it depended on changed), 2 soft, 3 other. */
  kind: Uint8Array;
  /** 1-based position in the generated code, as V8 reports it. */
  line: Uint32Array;
  col: Uint32Array;
  /** 1-based line in the original source, the one the source view shows; 0 when a map leads elsewhere. */
  origLine: Uint32Array;
  /** String table index of the id of the process track whose trace holds this row (workers share it). */
  proc: Uint32Array;
  count: Uint32Array;
}

/** Call tree in depth-first preorder: a node's subtree is the contiguous range [i, subtreeEnd[i]). */
export interface CallTree {
  length: number;
  parent: Int32Array;
  fn: Uint32Array;
  depth: Uint16Array;
  subtreeEnd: Uint32Array;
  /** Self time in microseconds. */
  self: Float64Array;
  /** Total time in microseconds. */
  total: Float64Array;
}

export interface Samples {
  length: number;
  /** Microseconds since `meta.startedAt`. */
  time: Float64Array;
  node: Uint32Array;
  /** Microseconds each sample stands for: the gap to the next sample (the last one uses the median gap). */
  dur: Float64Array;
}

/** Reconstructed calls: consecutive samples sharing a call path. Sorted by start, then depth. */
export interface SpanTable {
  length: number;
  node: Uint32Array;
  fn: Uint32Array;
  start: Float64Array;
  end: Float64Array;
  depth: Uint16Array;
  /** Index of the enclosing span, -1 at the root. */
  parent: Int32Array;
}

/** Top-level units of work. */
export interface TaskTable {
  length: number;
  start: Float64Array;
  end: Float64Array;
  kind: Uint8Array;
  label: Uint32Array;
  /** Index range into the track's SpanTable: [spanStart, spanEnd). */
  spanStart: Uint32Array;
  spanEnd: Uint32Array;
  /** Sampled self time excluding idle, microseconds. */
  busy: Float64Array;
  /**
   * Logical parent: index into the track's SpanTable of the call the first resumed function of this
   * task continues under (after resolving chains), -1 = none (attach to the run's entry root).
   */
  parentSpan: Int32Array;
  /** Span of the earlier segment of the same function that this task resumes, -1 = none. */
  resumeOf: Int32Array;
  /** Gap between the end of that earlier segment and the start of this task's first resumed call, microseconds (awaiting). */
  waitUs: Float64Array;
  /** How the stitch was made: 0 none, 1 inferred from an earlier call of the same function, 2 exact from async hooks, 3 attached where the previous task yielded. */
  stitch: Uint8Array;
  /** First non-runtime, non-plumbing function of the task (the one that resumed), -1 when there is none. */
  resumedFn: Int32Array;
  /** 1 = the task only runs runtime or plumbing frames (timer and I/O trampolines): nothing of the program's. */
  runtimeOnly: Uint8Array;
}

/**
 * One row per function resumed in a task (a task can resume several async functions in a row):
 * the logical parent each continues under. Ordered by task, then by first appearance.
 */
export interface ContinuationTable {
  length: number;
  task: Uint32Array;
  fn: Uint32Array;
  /** First span of the function in the task. */
  span: Uint32Array;
  /** Logical parent span (chains resolved), -1 = none. */
  parentSpan: Int32Array;
  /** Earlier segment being resumed, -1 = none. */
  resumeOf: Int32Array;
  waitUs: Float64Array;
  /** 0 none, 1 inferred, 2 exact from async hooks, 3 attached where the previous task yielded. */
  stitch: Uint8Array;
}

/** task -> task that scheduled it. Empty without `--async` data. */
export interface AsyncEdgeTable {
  length: number;
  from: Uint32Array;
  to: Uint32Array;
  /** Idle wait between the scheduling task ending and the target starting, microseconds. */
  waitUs: Float64Array;
}

export interface EventTable {
  gc: { time: Float64Array; duration: Float64Array; kind: Uint8Array };
  loop: { time: Float64Array; p50: Float64Array; p99: Float64Array; max: Float64Array };
  /** Request records are used to label request tasks. */
  requests: { time: Float64Array; duration: Float64Array; label: Uint32Array; status: Uint16Array };
}

/** Per function: line -> self samples, from V8 `positionTicks`, source mapped. */
export interface LineTicks {
  /** CSR layout: entries for function f are [offset[f], offset[f+1]). */
  offset: Uint32Array;
  line: Uint32Array;
  /** Self time in microseconds attributed to that line. */
  self: Float64Array;
}

/** Edges of the function-level call graph of one track, sorted by (caller, callee). */
export interface EdgeTable {
  length: number;
  caller: Uint32Array;
  callee: Uint32Array;
  /** Microseconds of callee total time reached through this caller. */
  weight: Float64Array;
  /** Estimated number of calls: contiguous runs seen in the samples. */
  count: Uint32Array;
}

/** Aggregates per track. Function arrays are aligned with `Track.fnIds`. */
export interface TrackAggregates {
  fnSelf: Float64Array;
  /** Total time per function, counting recursion once. */
  fnTotal: Float64Array;
  /** Estimated calls per function: spans seen in the samples. */
  fnCalls: Uint32Array;
  edges: EdgeTable;
}

/** Whole-run totals per npm package (all tracks), sorted by total time descending. */
export interface PackageTable {
  length: number;
  name: Uint32Array;
  self: Float64Array;
  total: Float64Array;
}

/** Whole-run busy time per task kind, indexed by `TaskKind`. */
export interface TaskKindStats {
  count: Uint32Array;
  busy: Float64Array;
  /** Self time of plumbing functions inside tasks of this kind. */
  plumbing: Float64Array;
}

/** `target`: the program being profiled (and its workers); `support`: launcher processes such as npx. */
export type TrackRole = 'target' | 'support';

/** What was profiled. `packages` is empty when the target is the project itself. */
export interface TargetInfo {
  /** npm package names whose functions are first-party (origin `user`), e.g. `['eslint']`. */
  packages: string[];
  /** Entry script of the primary track: project-relative inside the project root, absolute outside. */
  entry: string;
  kind: RunKind;
}

export interface Track {
  id: TrackId;
  kind: TrackKind;
  /** e.g. `eslint · pid 128952`, `npx · pid 128196 (supporting)`, `worker 1 · thread 1`. */
  label: string;
  role: TrackRole;
  /** Entry script of this track's process ('' when unknown), same form as `TargetInfo.entry`. */
  entry: string;
  /** Function row that stands for the whole run in stitched views: named after the entry script. */
  rootFn: FnId;
  parent?: TrackId;
  callTree: CallTree;
  samples: Samples;
  spans: SpanTable;
  tasks: TaskTable;
  asyncEdges: AsyncEdgeTable;
  continuations: ContinuationTable;
  events: EventTable;
  lines: LineTicks;
  agg: TrackAggregates;
  /** Function ids present in this track, ascending. */
  fnIds: Uint32Array;
  /** Whole-track busy time (non-idle self), microseconds. */
  busyUs: number;
  durationUs: number;
}

export type Severity = 'high' | 'medium' | 'low';

export type FindingKind =
  | 'event-loop-blocked'
  | 'sync-io'
  | 'hot-function'
  | 'hot-dependency'
  | 'hot-path'
  | 'gc-pressure'
  | 'async-overhead'
  | 'heavy-serialization'
  | 'late-module-loading'
  | 'event-loop-lag'
  | 'v8-deopt';

/** What the UI should select and which view proves a finding. */
export interface ShowMe {
  view: 'waterfall' | 'flame' | 'callgraph' | 'functions' | 'timeline';
  track?: TrackId;
  /** Function to select. */
  fn?: FnId;
  /** Task index within `track` to select. */
  task?: number;
  /** Time range in microseconds. */
  range?: [number, number];
  /** Source line to scroll to (1-based, original file). */
  line?: number;
  /** View-specific switches, e.g. critical path on, plumbing unmerged, package expanded. */
  options?: Record<string, string | number | boolean>;
}

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: Severity;
  /** Short heading, e.g. "Event loop blocked". */
  title: string;
  /** One sentence with a number. */
  summary: string;
  /** What to change, when the rule knows (V8 deopt reasons map to a concrete fix). */
  hint?: string;
  /** Why it was flagged: the rule and thresholds, shown inside the finding. */
  rule: string;
  /** Share of track time or similar, for ranking (0..1). */
  impact: number;
  showMe: ShowMe;
  /** Function ids that are the evidence. */
  evidence: FnId[];
  track?: TrackId;
}

export interface ExecutionModel {
  meta: SessionMeta;
  strings: string[];
  functions: FunctionTable;
  tracks: Track[];
  packages: PackageTable;
  taskKinds: TaskKindStats;
  findings: Finding[];
  deopts: DeoptTable;
  target: TargetInfo;
  /** Index into `tracks` of the program being profiled: the busiest track that is not supporting. */
  primaryTrack: number;
}
