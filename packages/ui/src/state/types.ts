export type ViewId = 'waterfall' | 'flame' | 'callgraph' | 'functions';

export const VIEW_ORDER: readonly ViewId[] = ['waterfall', 'flame', 'callgraph', 'functions'];

export const VIEW_LABELS: Record<ViewId, string> = {
  waterfall: 'Waterfall',
  flame: 'Flame graph',
  callgraph: 'Call graph',
  functions: 'Functions',
};

/** One selection drives every view: a function, a call node, a span, a task or a time range. */
export type Selection =
  | { kind: 'none' }
  | { kind: 'fn'; fn: number }
  /** A call: function ids from the root's child down, in the current track and transform stack. */
  | { kind: 'node'; track: string; path: number[] }
  | { kind: 'task'; track: string; task: number }
  | { kind: 'range'; from: number; to: number };

export const NO_SELECTION: Selection = { kind: 'none' };

/** Transform descriptors; applied in order to the model by the query layer. */
export type Transform =
  | { k: 'collapse-deps' }
  | { k: 'merge-plumbing' }
  | { k: 'drop-idle' }
  | { k: 'collapse-pkg'; pkg: string }
  | { k: 'merge-fn'; fn: number }
  | { k: 'merge-node'; path: number[] }
  | { k: 'focus-fn'; fn: number }
  | { k: 'focus-self'; fn: number }
  | { k: 'focus-node'; path: number[] }
  | { k: 'collapse-rec'; fn: number }
  | { k: 'drop-fn'; fn: number }
  | { k: 'invert' };

export type TimeRange = readonly [number, number];

export type FlameSort = 'heavy' | 'alpha';
export type FlameColor = 'origin' | 'self';
export type FlameLayout = 'icicle' | 'flames';

export interface ViewOptions {
  /** Outline the widest-child chain in the waterfall. */
  critical: boolean;
  /** Collapse every waterfall row except the critical chain (`p`). */
  pathOnly: boolean;
  logical: boolean;
  sort: FlameSort;
  color: FlameColor;
  layout: FlameLayout;
  ego: boolean;
  /** Flame graph zoom path: call node ids from the root, in the transformed tree. */
  zoom: number[];
  /** Task index in the selected track for the waterfall; -1 means the longest task. */
  task: number;
  /** Call-graph packages expanded in place. */
  expanded: string[];
  /** Source line to scroll to (1-based); 0 means the hottest line. */
  line: number;
}

/** Everything the URL hash and the history stack carry. */
export interface Snapshot {
  view: ViewId;
  track: string;
  selection: Selection;
  range: TimeRange | null;
  transforms: Transform[];
  options: ViewOptions;
}

export const DEFAULT_OPTIONS: ViewOptions = {
  critical: true,
  pathOnly: false,
  logical: true,
  sort: 'heavy',
  color: 'origin',
  layout: 'icicle',
  ego: true,
  zoom: [],
  task: -1,
  expanded: [],
  line: 0,
};

/** The default stack, in UI form; the engine's `DEFAULT_TRANSFORMS` is its twin. */
export const DEFAULT_TRANSFORMS: readonly Transform[] = [
  { k: 'collapse-deps' },
  { k: 'merge-plumbing' },
  { k: 'drop-idle' },
];

/** The default track: resolves to the first (main) track; the engine has no cross-track view. */
export const ALL_TRACKS = 'all';

export function initialSnapshot(): Snapshot {
  return {
    view: 'waterfall',
    track: ALL_TRACKS,
    selection: NO_SELECTION,
    range: null,
    transforms: DEFAULT_TRANSFORMS.map((t) => ({ ...t })),
    options: { ...DEFAULT_OPTIONS },
  };
}
