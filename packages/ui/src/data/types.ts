import type { Finding, ModelWarning, RunKind } from '@pacesjs/engine';
import type { Selection, TimeRange, Transform } from '../state/types';
import type { RunMark } from './marks';

// View models: what the components render. Every number comes from an engine query; the adapter
// only attaches display text (names, locations) and renames fields for the views.

/** What every aggregate query is scoped by. */
export interface Scope {
  track: string;
  transforms: Transform[];
  range: TimeRange | null;
  /** Origins hidden by the Show filter (engine origin ids); their self time moves to the caller. */
  hide: number[];
}

export interface TrackSummary {
  id: string;
  label: string;
  kind: string;
  /** `support` tracks are launcher processes such as npx, shown muted and after the target. */
  role: 'target' | 'support';
  /** The target process: the default track. */
  primary: boolean;
  /** Entry script of this track's process ('' when unknown). */
  entry: string;
  samples: number;
  durationUs: number;
}

export interface TargetSummary {
  /** Entry script of the primary track, e.g. `eslint/bin/eslint.js`. */
  entry: string;
  kind: RunKind;
  /** npm packages whose functions are first-party for this run. */
  packages: string[];
}

export interface ModelSummary {
  command: string[];
  durationUs: number;
  intervalUs: number;
  precisionUs: number;
  endedBy: string;
  mode: string;
  /** Target first, then its workers, then supporting processes. */
  tracks: TrackSummary[];
  /** Id of the target process: the default track. */
  primaryTrack: string;
  target: TargetSummary;
  /** In the engine's ranking order: the first one is the top finding. */
  findings: Finding[];
  warnings: ModelWarning[];
  totalSamples: number;
  projectRoot: string;
  functionCount: number;
  /** Every package name, sorted: collapsed package `i` has function id `functionCount + i`. */
  packages: string[];
  hasBaseline: boolean;
  /** Moments the user flagged while profiling, in time order. */
  marks: RunMark[];
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
  /** Plumbing function: the default transforms merge it away, so no row shows it. */
  plumbing: boolean;
}

export const EMPTY_SELECTION: SelectionInfo = {
  fn: null,
  path: null,
  name: '',
  track: null,
  task: null,
  loc: '',
  plumbing: false,
};

export interface TaskOption {
  index: number;
  group:
    'Whole run' | 'Entry' | 'Requests' | 'Timers' | 'I/O' | 'Microtasks' | 'Other' | 'Small tasks';
  /** Little busy time or only runtime frames. */
  trivial: boolean;
  label: string;
  startUs: number;
  durationUs: number;
  busyUs: number;
  longest: boolean;
}

// ---- Waterfall ----

export interface WaterfallRow {
  /** Row id: index in `rows`; row 0 is the task itself. */
  id: number;
  /** `fold`: a synthetic parent that stands for rows hidden by the UI (starts collapsed). */
  kind: 'task' | 'call' | 'wait' | 'summary' | 'fold';
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
  /** Another segment of a call, resumed after an await (inferred unless run with --async). */
  resumed: boolean;
  /** Summary row: the tasks it stands for. */
  summaryTasks: number[];
  /** Self time in microseconds. */
  selfUs: number;
  /** Fold rows: what they hide. */
  fold?: 'small' | 'bootstrap';
  /** Fold rows: how many rows they stand for. */
  foldedCount?: number;
}

export interface WaterfallData {
  /** `run`: the whole logical execution (default); `task`: one task; `range`: a time window. */
  mode: 'run' | 'task' | 'range';
  /** Task index, or -1 for the whole run and for a time range. */
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
  /** Function ids of a call chain to zoom to (hot paths); wins over `zoom` when it resolves. */
  zoomPath: number[];
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

/** The numbers of one call node of the tree (this call, not every call of its function). */
export interface CallNumbers {
  /** CPU time of the call: its own time and everything it called. */
  totalUs: number;
  selfUs: number;
  /** What the call called directly, largest first. */
  callees: Array<{ fn: number; name: string; origin: number; totalUs: number }>;
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
  /** The synthetic root named after the entry script. */
  isEntry: boolean;
  /** Recursive calls into itself: drawn as a badge, never as a self-loop arc. */
  recursion: number;
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
  /** Frames between caller and callee that were left out (drawn dashed, "via N frames"). */
  hiddenFrames: number;
}

export interface CallGraphData {
  nodes: CgNode[];
  edges: CgEdge[];
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
  /** Line of the function's definition: the selection highlight and the scroll target. */
  definitionLine: number;
  lineSelf: Array<{ line: number; selfUs: number }>;
  hottestLine: number;
  /** Activity per time bin across the run, 0..1 relative to the busiest bin. */
  spark: number[];
  sparkTrack: string;
  durationUs: number;
  mapMissing: boolean;
  mapped: boolean;
  loc: string;
  /** The engine's verdict on line-level time, with one sentence for the user. */
  lineStatus: 'self-lines' | 'no-self-time' | 'no-line-data';
  lineReason: string;
  /** Callees of the function with the time under them. */
  calleeTime: Array<{
    fn: number;
    name: string;
    origin: number;
    selfUs: number;
    totalUs: number;
  }>;
}

export interface HotPathRow {
  /** Function ids of the chain, outermost first. */
  fns: number[];
  names: string[];
  /** `file:line` of the last frame. */
  loc: string;
  selfUs: number;
  totalUs: number;
  /** Share of the track's busy time. */
  share: number;
}

/** Time hidden by the origin filter, per origin group, for the "hiding ..." chip. */
export interface HiddenOrigin {
  origin: number;
  selfUs: number;
}

export interface OutlineItem {
  fn: number;
  name: string;
  line: number;
  selfUs: number;
  totalUs: number;
  origin: number;
}

/** The functions of one file that ran, in line order: the outline beside the full source view. */
export interface FileOutline {
  path: string;
  items: OutlineItem[];
}

// ---- Overview lanes ----

export interface LaneData {
  id: string;
  label: string;
  meta: string;
  /** Supporting launcher process (npx): drawn muted, after the target. */
  support: boolean;
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
