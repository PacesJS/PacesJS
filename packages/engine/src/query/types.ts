// Types of the query and transform layer. The UI worker builds a `TransformedView` once per
// (track, transform stack) and every view reads it through the pure query functions.

import type { CallTree, FnId, NodeId, OriginId, Samples, TaskKindId } from '../model.js';

/** Function ids >= `model.functions.length` are synthetic nodes made by "collapse package". */
export type ViewFnId = number;

export type Transform =
  | { kind: 'merge-function'; fn: FnId }
  /** `path` is the chain of function ids from the root's child down to the node. */
  | { kind: 'merge-node'; path: FnId[] }
  | { kind: 'focus-subtree'; path: FnId[] }
  | { kind: 'focus-function'; fn: FnId }
  | { kind: 'focus-function-self'; fn: FnId }
  | { kind: 'collapse-package'; pkg: string }
  | { kind: 'collapse-recursion'; fn: FnId }
  | { kind: 'drop-samples'; fn: FnId }
  | { kind: 'time-range'; start: number; end: number }
  | { kind: 'invert' }
  | { kind: 'collapse-dependencies' }
  | { kind: 'merge-plumbing' }
  | { kind: 'drop-idle' }
  /** Merges frames of these origins into their nearest kept caller (self time moves up). Never hides the root. */
  | { kind: 'hide-origins'; origins: OriginId[] }
  /**
   * Grafts the stacks of resumed async functions under the parent path of the call they continue and
   * roots everything at a function named after the entry script. Only effective as the first step.
   */
  | { kind: 'stitch-continuations' };

export type TransformKind = Transform['kind'];

/** The stack the UI opens with: stitch continuations, collapse dependencies, merge plumbing, drop idle. */
export const DEFAULT_TRANSFORMS: readonly Transform[] = [
  { kind: 'stitch-continuations' },
  { kind: 'collapse-dependencies' },
  { kind: 'merge-plumbing' },
  { kind: 'drop-idle' },
];

/** What every view reads: a call tree plus the samples that survived the transform stack. */
export interface TransformedView {
  trackIndex: number;
  stack: readonly Transform[];
  /** Preorder tree; node 0 is always the synthetic `(root)`. Self/total are microseconds. */
  tree: CallTree;
  /** Time-ordered samples; `node` indexes `tree`. */
  samples: Samples;
  inverted: boolean;
  /** Total retained sample time in microseconds (what shares are relative to). */
  totalUs: number;
  /** Packages that were collapsed, indexed by `fn - model.functions.length`. */
  syntheticPackages: string[];
}

export interface FunctionInfo {
  fn: ViewFnId;
  name: string;
  file: string;
  line: number;
  col: number;
  origin: OriginId;
  pkg: string;
  plumbing: boolean;
  mapped: boolean;
  mapMissing: boolean;
  /** True for a collapsed-package node. */
  synthetic: boolean;
}

// ---- Selection ----

export type Selection =
  | { kind: 'function'; fn: FnId }
  | { kind: 'node'; path: FnId[] }
  | { kind: 'span'; trackIndex: number; span: number }
  | { kind: 'task'; trackIndex: number; task: number }
  | { kind: 'range'; start: number; end: number };

/** Ids to highlight in each view for a hover or selection. */
export interface RelatedIds {
  fns: ViewFnId[];
  /** View-tree nodes (flame graph rects, call graph is keyed by fn). */
  nodes: NodeId[];
  /** Spans of the track (waterfall rows are keyed by `WaterfallRow.span` when present). */
  spans: number[];
  tasks: number[];
  range: [number, number] | null;
}

// ---- Waterfall ----

export interface WaterfallRow {
  /** Index in `Waterfall.rows`. */
  id: number;
  /**
   * `call`: a call; `wait`: idle time (waiting for an async edge, or `awaiting` between two segments of
   * one call); `summary`: "N small tasks" standing for `summaryTasks`.
   */
  kind: 'call' | 'wait' | 'summary';
  fn: ViewFnId;
  /** View-tree node, -1 for wait rows. */
  node: NodeId;
  start: number;
  end: number;
  /** Duration of the row in microseconds. */
  durUs: number;
  /** Self time in microseconds. */
  selfUs: number;
  depth: number;
  /** Row id of the parent, -1 at the top. */
  parent: number;
  /** Share of the task or range, 0..1. */
  share: number;
  /** Widest child at each level, starting from the widest root. */
  critical: boolean;
  /** Shorter than two sampling intervals: draw hatched, label "< N ms". */
  hatched: boolean;
  /** Task this row belongs to (the scheduled task for rows reached over an async edge), or -1. */
  task: number;
  /** Wait and summary rows: human label such as "idle wait ~8 ms", "awaiting ~7 ms", "3 small tasks · ~2 ms". */
  label: string;
  /** The call resumes after an await: another segment of the same logical call (whole-run waterfall). */
  resumed: boolean;
  /** Summary rows: the tasks (indexes into `Track.tasks`) rolled into the row; open them with `waterfallForTask`. */
  summaryTasks: number[];
}

export interface WaterfallMinimap {
  start: number;
  end: number;
  /** Busy fraction (0..1) per bucket across [start, end]. */
  busy: Float32Array;
}

export interface Waterfall {
  start: number;
  end: number;
  precisionUs: number;
  rows: WaterfallRow[];
  /** Row ids on the critical path, root first. */
  criticalPath: number[];
  minimap: WaterfallMinimap;
  /** True when the rows include rows reached over async edges. */
  hasAsyncFlow: boolean;
}

export interface WaterfallOptions {
  minimapBuckets?: number;
  /** Follow async edges out of the task (default true; no effect without async data). */
  followAsync?: boolean;
  /** Rows deeper than this are omitted (default unlimited). */
  maxDepth?: number;
  /** Merge frames of these origins into their caller before building rows. */
  hideOrigins?: OriginId[];
  /** Omit rows shorter than this, with everything beneath them. */
  minDurationUs?: number;
  /**
   * How siblings are ordered: by start time (default), or by duration or share, longest first.
   * Rows stay in depth-first order and `id` stays the row's index in `rows`.
   */
  sort?: 'time' | 'duration' | 'share';
}

/** Options of the whole-run waterfall: the task waterfall's, plus what to fold. */
export interface RunWaterfallOptions extends WaterfallOptions {
  /**
   * Tasks with less busy time than this, or that only run runtime frames, become one summary row per gap
   * instead of rows. Default: the larger of 0.5 ms and 0.1% of the run. 0 turns collapsing off.
   */
  collapseTrivialUs?: number;
  /** The transform stack of the view (default `DEFAULT_TRANSFORMS`). */
  transforms?: readonly Transform[];
}

// ---- Flame graph ----

export type FlameSort = 'left-heavy' | 'alphabetical';
export type FlameColorBy = 'origin' | 'self' | 'diff';

export interface FlameOptions {
  sort?: FlameSort;
  /** Icicle puts the root on row 0 (default); classic puts it on the last row. */
  orientation?: 'icicle' | 'classic';
  /** Zoom: lay out only this node's subtree, its width becomes 1. */
  zoomNode?: NodeId;
  colorBy?: FlameColorBy;
  /** Required for `colorBy: 'diff'`. */
  diff?: ModelDiff;
  /** Rects narrower than this fraction of the root are omitted (default 0 = keep all). */
  minWidth?: number;
}

/** One entry per rect, parallel typed arrays; `x` and `w` are fractions of the laid-out root. */
export interface FlameLayout {
  length: number;
  node: Uint32Array;
  fn: Uint32Array;
  depth: Uint16Array;
  /** Row index with orientation applied (icicle: depth; classic: maxDepth - depth). */
  row: Uint16Array;
  x: Float64Array;
  w: Float64Array;
  self: Float64Array;
  total: Float64Array;
  origin: Uint8Array;
  plumbing: Uint8Array;
  /** 0..1: self-time intensity for `colorBy: 'self'`, change magnitude for `'diff'`, else 0. */
  intensity: Float32Array;
  /** `'diff'` only: -1 faster, 0 unchanged, 1 slower, 2 new in head. */
  change: Int8Array;
  maxDepth: number;
  totalUs: number;
  /** Zoom breadcrumb: node ids from the root to the zoomed node. */
  zoomPath: NodeId[];
}

// ---- Call graph ----

export interface CallGraphOptions {
  /** Cover this share of total time (default 0.8). */
  coverage?: number;
  /** Never show more nodes than this (default 40, or 25 without `prioritizeTarget`). */
  maxNodes?: number;
  /**
   * Keep the target's own functions (origin user) with total >= 1% or self >= 0.5% of busy time first, then fill
   * with the heaviest others (default true). False: only the heaviest by self time up to `coverage`.
   */
  prioritizeTarget?: boolean;
  /** Ego mode: center on this function, 2 callers up and 2 callees down. */
  ego?: ViewFnId;
  /** Functions whose hidden neighbours were revealed with the "+N" chip. */
  expanded?: ViewFnId[];
}

export interface CallGraphNode {
  fn: ViewFnId;
  /** Self and total microseconds across the track view. */
  self: number;
  total: number;
  selfShare: number;
  totalShare: number;
  /** Callers and callees not drawn, shown as "+N" chips. */
  hiddenCallers: number;
  hiddenCallees: number;
  /** Ego mode: outside the ego neighbourhood, drawn faded. */
  faded: boolean;
  /** Number of recursive calls (self edge); drawn as a back-edge loop with this count. */
  recursion: number;
  /** Synthetic collapsed-package node. */
  isPackage: boolean;
  /** The synthetic root named after the entry script (stitched views): always drawn, at the top. */
  isEntry: boolean;
}

export interface CallGraphEdge {
  from: ViewFnId;
  to: ViewFnId;
  /** Microseconds of callee time reached through this caller. */
  weight: number;
  /** Share of total time. */
  share: number;
  /** Estimated call count. */
  count: number;
  /** Edge closes a cycle (drawn as a back edge). */
  back: boolean;
  /** Frames between caller and callee that were pruned; > 0 draws dashed, "via N frames". */
  hiddenFrames: number;
}

export interface CallGraph {
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
  /** Nodes left out by pruning. */
  hiddenNodes: number;
  totalUs: number;
}

// ---- Functions table, sandwich ----

export type FunctionSortKey = 'self' | 'total' | 'name' | 'calls' | 'origin' | 'package' | 'file';

export interface FunctionRowsOptions {
  /** Default 'self'. */
  sort?: FunctionSortKey;
  /** Default 'desc' for numbers, 'asc' for text keys. */
  direction?: 'asc' | 'desc';
  /** Case-insensitive match on name, file or package. */
  search?: string;
  /** User code first (default true). */
  userFirst?: boolean;
  /** Keep idle, gc and root rows (default false). */
  includeIdle?: boolean;
  /** Keep only functions of these origins (collapsed package rows count as dependencies). */
  origins?: OriginId[];
  /** Keep only functions of this npm package, including its collapsed package row. */
  pkg?: string;
}

export interface FunctionRow {
  fn: ViewFnId;
  name: string;
  file: string;
  line: number;
  pkg: string;
  origin: OriginId;
  plumbing: boolean;
  self: number;
  total: number;
  selfShare: number;
  totalShare: number;
  /** Estimated calls (contiguous runs seen in the samples). */
  calls: number;
}

export interface Sandwich {
  fn: ViewFnId;
  /** Callers inverted: the function at the root, its callers as children, deeper = further up. */
  callers: FlameLayout;
  callees: FlameLayout;
}

// ---- Source ----

export interface LineSelf {
  /** 1-based original line. */
  line: number;
  selfUs: number;
  /** Share of the function's self time. */
  share: number;
}

/** A callee reached from the function. Sampled profiles carry no call-site line, so `line` is 0. */
export interface CallSite {
  callee: ViewFnId;
  line: number;
  calleeUs: number;
  calls: number;
}

/** A callee of the function with the time under it. Sampled profiles carry no call-site line: `line` is never set. */
export interface CalleeTime {
  fn: ViewFnId;
  name: string;
  pkg: string;
  /** Self time of the callee's calls made from this function. */
  selfUs: number;
  /** Total time of those calls. */
  totalUs: number;
  line?: number;
}

/** Why the source panel can or cannot show line-level time for a function. */
export interface LineInfo {
  /**
   * `self-lines`: V8 attributed self time to lines. `no-self-time`: the function itself ran little, its time is in
   * callees. `no-line-data`: it ran, but V8 recorded no line positions (inlined, native, collapsed package).
   */
  status: 'self-lines' | 'no-self-time' | 'no-line-data';
  /** One honest sentence for the UI. */
  reason: string;
}

export interface FunctionSourceInfo {
  fn: ViewFnId;
  name: string;
  file: string;
  line: number;
  /** 1-based line of the function's definition in the original file (0 for collapsed packages). */
  definitionLine: number;
  selfUs: number;
  totalUs: number;
  /** Lines with self time, ascending by line. */
  lines: LineSelf[];
  hottestLine: number;
  /** Lines with self time, most time first (at most 8). */
  hotLines: LineSelf[];
  callSites: CallSite[];
  /** Callees with the time under this function, largest total first. */
  calleeTime: CalleeTime[];
  lineInfo: LineInfo;
  /** Busy fraction of this function per bucket across the track (for the header sparkline). */
  sparkline: Float32Array;
  mapMissing: boolean;
}

// ---- Hot paths, package breakdown, callers ----

export interface FunctionLocation {
  name: string;
  /** Project-relative original path (absolute outside the project), or a node: URL. */
  file: string;
  /** 1-based original line of the function's definition. */
  line: number;
}

/** A call chain, outermost frame first, that carries a share of the track's busy time. */
export interface HotPath {
  fns: FnId[];
  locations: FunctionLocation[];
  /** Self time of the last frame, microseconds (dependency time under it is included when hidden). */
  selfUs: number;
  /** Total time of the last frame. */
  totalUs: number;
  /** `totalUs` as a share of the track's busy time, 0..1. */
  share: number;
}

export interface HotPathOptions {
  /** At most this many chains (default 8). */
  limit?: number;
  /** A frame counts while it carries at least this share of busy time (default 0.02). */
  minShare?: number;
  /** Only frames of this origin appear; other frames fold into their caller (e.g. `Origin.User`). */
  origin?: OriginId;
}

export interface PackageFunction extends FunctionLocation {
  fn: FnId;
  self: number;
  total: number;
}

export interface CallerNode extends FunctionLocation {
  fn: FnId;
  /** Microseconds of this function's time reached through the caller. */
  weightUs: number;
  /** Estimated calls from the caller. */
  calls: number;
  /** Callers of this caller, one level further up. */
  callers: CallerNode[];
}

// ---- Task list ----

export type TaskGroup =
  'Whole run' | 'Entry' | 'Requests' | 'Timers' | 'I/O' | 'Microtasks' | 'Other' | 'Small tasks';

/** One row of the task picker: what ran, when, and how busy it was. */
export interface TaskDescriptor {
  /** Index into `Track.tasks`; -1 for the whole-run row (open it with `waterfallForRun`). */
  index: number;
  group: TaskGroup;
  /** Entry kind plus the first frame of the target's code, e.g. `request · GET /orders`. */
  label: string;
  startUs: number;
  durationUs: number;
  /** Sampled self time without idle. */
  busyUs: number;
  /** The single longest task of the track (the whole-run row is never it). */
  longest: boolean;
  /** Little busy time or only runtime frames: listed under 'Small tasks' and folded in the run waterfall. */
  trivial: boolean;
}

// ---- Track timeline ----

export interface TimelineTaskBlock {
  task: number;
  start: number;
  end: number;
  kind: TaskKindId;
  label: string;
  /** Over 50 ms: the long-task corner tick. */
  long: boolean;
}

export interface TimelineMarker {
  time: number;
  /** Microseconds for GC pauses, loop delay (p99) otherwise. */
  durationUs: number;
}

export interface TimelineLane {
  trackIndex: number;
  start: number;
  end: number;
  /** CPU activity (non-idle fraction, 0..1) per bucket. */
  cpu: Float32Array;
  /** Share of user-code samples per bucket, 0..1 of the bucket. */
  user: Float32Array;
  tasks: TimelineTaskBlock[];
  gc: TimelineMarker[];
  loopDelay: TimelineMarker[];
  bucketUs: number;
}

export interface TimelineOptions {
  buckets?: number;
  start?: number;
  end?: number;
  /** Long-task threshold in microseconds (default 50 000). */
  longTaskUs?: number;
}

// ---- Differential (v1.x) ----

export interface DiffFunction {
  /** Stable key: project-relative original path, function name and original line. */
  key: string;
  name: string;
  file: string;
  line: number;
  baseFn: FnId | -1;
  headFn: FnId | -1;
  baseSelfUs: number;
  headSelfUs: number;
  baseTotalUs: number;
  headTotalUs: number;
  /** Change of share of busy time, head minus base (positive = slower). */
  selfShareDelta: number;
}

export interface ModelDiff {
  functions: DiffFunction[];
  /** Indexed by head function id: change of self share of busy time (head minus base). */
  headSelfShareDelta: Float64Array;
  /** Indexed by head function id: 0 unchanged, 1 slower, -1 faster, 2 new in head. */
  headChange: Int8Array;
  baseBusyUs: number;
  headBusyUs: number;
}
