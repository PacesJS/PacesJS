import type { Finding } from '@pacesjs/engine';
import type { Selection, TimeRange, Transform } from '../state/types';

// View models: what the components render. Every number comes from an engine query; the adapter
// only attaches display text (names, locations) and renames fields for the views.

/** What every aggregate query is scoped by. */
export interface Scope {
  track: string;
  transforms: Transform[];
  range: TimeRange | null;
}

export interface TrackSummary {
  id: string;
  label: string;
  kind: string;
  samples: number;
  durationUs: number;
}

export interface ModelSummary {
  command: string[];
  durationUs: number;
  intervalUs: number;
  precisionUs: number;
  endedBy: string;
  mode: string;
  tracks: TrackSummary[];
  /** In the engine's ranking order: the first one is the top finding. */
  findings: Finding[];
  warnings: string[];
  totalSamples: number;
  projectRoot: string;
  functionCount: number;
  hasBaseline: boolean;
}

export interface TaskInfo {
  index: number;
  label: string;
  startUs: number;
  durationUs: number;
  busyUs: number;
  kind: number;
}

export interface SelectionInfo {
  fn: number | null;
  /** Path of function ids for a call-node selection. */
  path: number[] | null;
  name: string;
  track: string | null;
  task: TaskInfo | null;
  loc: string;
}

export interface TaskOption {
  index: number;
  label: string;
  startUs: number;
  durationUs: number;
  longest: boolean;
}

// ---- Waterfall ----

export interface WaterfallRow {
  /** Row id: index in `rows`; row 0 is the task itself. */
  id: number;
  kind: 'task' | 'call' | 'wait';
  /** Function id, -1 for the task and wait rows. */
  fn: number;
  /** Function ids from the root's child to this call, for the selection. Empty for task/wait rows. */
  path: number[];
  name: string;
  loc: string;
  origin: number;
  /** Microseconds from the start of the task or range. */
  start: number;
  end: number;
  depth: number;
  parent: number;
  hasChildren: boolean;
  critical: boolean;
  belowPrecision: boolean;
  share: number;
}

export interface WaterfallData {
  /** Task index, or -1 for a time range. */
  taskIndex: number;
  trackId: string;
  taskLabel: string;
  taskUs: number;
  taskStartUs: number;
  rows: WaterfallRow[];
  /** Row ids on the critical path, task row first. */
  criticalRows: number[];
  hasAsync: boolean;
}

// ---- Flame graph ----

export interface FlameOptions {
  sort: 'heavy' | 'alpha';
  color: 'origin' | 'self';
  /** Transformed call node ids, outermost first. */
  zoom: number[];
}

/** Columnar frames for the canvas. x and w are fractions of the zoomed root's total. */
export interface FlameData {
  length: number;
  /** Transformed call node, or -1 for the "all samples" root. */
  node: Int32Array;
  depth: Uint16Array;
  x: Float64Array;
  w: Float64Array;
  fn: Uint32Array;
  origin: Uint8Array;
  /** 0..1 self-time intensity for the by-self-time color. */
  heat: Float32Array;
  totalUs: Float64Array;
  selfUs: Float64Array;
  /** Differential mode: -1 (faster) to +1 (slower). */
  delta?: Float32Array;
  names: string[];
  locs: string[];
  rootUs: number;
  maxDepth: number;
  crumbs: Array<{ node: number; name: string }>;
}

// ---- Functions, details, sandwich ----

export interface FnRow {
  fn: number;
  name: string;
  origin: number;
  pkg: string;
  selfUs: number;
  totalUs: number;
  /** Fraction of the wall time of the selected track (or range). */
  share: number;
  calls: number;
  loc: string;
}

export interface FunctionsResult {
  rows: FnRow[];
  /** Functions in the transformed tree before filtering. */
  totalFns: number;
  baseUs: number;
}

export interface RelatedRow {
  fn: number | null;
  name: string;
  origin: number;
  /** Fraction of the selected function's total time. */
  frac: number;
  kind: 'caller' | 'callee' | 'self';
}

export interface Details {
  fn: number;
  name: string;
  loc: string;
  origin: number;
  pkg: string;
  totalUs: number;
  selfUs: number;
  share: number;
  calls: number;
  callers: RelatedRow[];
  callees: RelatedRow[];
}

export interface SandwichRow {
  /** Negative = callers above, 0 = the function, positive = callees below. */
  level: number;
  name: string;
  origin: number;
  fn: number | null;
  start: number;
  end: number;
  isSelf: boolean;
}

// ---- Call graph ----

export interface CgNode {
  fn: number;
  name: string;
  /** Short location or kind: "orders.ts:18", "package", "native". */
  sub: string;
  origin: number;
  isPackage: boolean;
  selfUs: number;
  totalUs: number;
  hiddenCallers: number;
  hiddenCallees: number;
  /** Functions a collapsed package stands for. */
  members: number;
}

export interface CgEdge {
  from: number;
  to: number;
  timeUs: number;
  /** Share of the caller's total time. */
  share: number;
  calls: number;
  /** Closes a cycle. */
  back: boolean;
}

export interface CallGraphData {
  nodes: CgNode[];
  edges: CgEdge[];
  loops: Array<{ fn: number; count: number }>;
  shownFns: number;
  totalFns: number;
  maxSelfUs: number;
  maxTotalUs: number;
  maxEdgeUs: number;
}

export interface CallGraphQuery {
  /** Show up to 200 functions instead of pruning to 80% of self time. */
  all: boolean;
  /** Functions whose hidden neighbours were revealed with a "+N" chip. */
  revealed: number[];
  /** Selected function for ego fading, or null. */
  ego: number | null;
}

// ---- Source ----

export interface SourceInfo {
  fn: number;
  /** Project-relative path to read through the host, or '' for functions without a file. */
  path: string;
  startLine: number;
  lineSelf: Array<{ line: number; selfUs: number }>;
  hottestLine: number;
  /** Activity per time bin across the run, 0..1 relative to the busiest bin. */
  spark: number[];
  sparkTrack: string;
  durationUs: number;
  mapMissing: boolean;
  mapped: boolean;
  loc: string;
}

// ---- Overview lanes ----

export interface LaneData {
  id: string;
  label: string;
  meta: string;
  durationUs: number;
  cpu: Float32Array;
  taskStart: Float64Array;
  taskEnd: Float64Array;
  /** Over 50 ms and not startup (the engine's long-task rule). */
  taskLong: Uint8Array;
  /** Dominant origin per task (0 = your code). */
  taskOrigin: Uint8Array;
  taskLabels: string[];
  gcTime: Float64Array;
  gcDuration: Float64Array;
  /** Event-loop delay p99 per bin, microseconds. */
  delay: Float32Array;
  peakDelayUs: number;
  peakDelayAtUs: number;
  hasLoopData: boolean;
}

export interface OverviewData {
  durationUs: number;
  bins: number;
  lanes: LaneData[];
}

export type { Selection };
