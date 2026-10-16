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
export const ORIGIN_NAMES = ['user', 'dependency', 'framework', 'node', 'native', 'idle', 'gc'] as const;

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
export const TASK_KIND_NAMES = ['main', 'request', 'timer', 'immediate', 'microtask', 'io', 'other'] as const;

export interface SessionMeta extends CaptureMeta {
  /** ± measurement precision in microseconds (one sampling interval). */
  precisionUs: number;
  /** Whole-run duration in microseconds. */
  durationUs: number;
  engineVersion: string;
  /** Warnings raised by passes, e.g. missing source maps. */
  warnings: string[];
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

export interface Track {
  id: TrackId;
  kind: TrackKind;
  label: string;
  parent?: TrackId;
  callTree: CallTree;
  samples: Samples;
  spans: SpanTable;
  tasks: TaskTable;
  asyncEdges: AsyncEdgeTable;
  events: EventTable;
  lines: LineTicks;
  /** Function ids present in this track. */
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
  | 'gc-pressure'
  | 'async-overhead'
  | 'heavy-serialization'
  | 'late-module-loading'
  | 'event-loop-lag';

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
  findings: Finding[];
}
