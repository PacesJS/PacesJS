// Call graph: one node per function, edges caller -> callee, pruned to what matters.
// Layout is left to the UI; this returns nodes and edges only.
//
// Edge `count` is the estimated number of calls: contiguous runs of samples inside the callee's
// call nodes (a call shorter than the sampling interval cannot be seen).

import { Origin } from '../model.js';
import type { CallTree, ExecutionModel, Samples } from '../model.js';
import type {
  CallGraph,
  CallGraphEdge,
  CallGraphNode,
  CallGraphOptions,
  TransformedView,
  ViewFnId,
} from './types.js';

interface RawEdge {
  from: number;
  to: number;
  weight: number;
  count: number;
  hiddenFrames: number;
}

/** Contiguous runs of samples per call node: a run starts when the previous sample was elsewhere. */
export function runsPerNode(tree: CallTree, samples: Samples): Uint32Array {
  const runs = new Uint32Array(tree.length);
  let prev = -1;
  for (let s = 0; s < samples.length; s++) {
    const leaf = samples.node[s] ?? 0;
    for (let n = leaf; n > 0; n = tree.parent[n] ?? 0) {
      if (prev >= 0 && n <= prev && prev < (tree.subtreeEnd[n] ?? 0)) break;
      runs[n] = (runs[n] ?? 0) + 1;
    }
    prev = leaf;
  }
  return runs;
}

/**
 * Visits every call node in preorder, telling whether it is an outermost call of its function (no
 * ancestor runs the same function), which is what keeps recursion from doubling time.
 */
function forEachCall(
  tree: CallTree,
  visit: (node: number, fn: number, outermost: boolean) => void,
): void {
  const active = new Map<number, number>();
  const open: number[] = [];
  for (let i = 1; i < tree.length; i++) {
    while (open.length > 0 && (tree.subtreeEnd[open[open.length - 1] ?? 0] ?? 0) <= i) {
      const done = tree.fn[open.pop() ?? 0] ?? 0;
      active.set(done, (active.get(done) ?? 1) - 1);
    }
    const fn = tree.fn[i] ?? 0;
    visit(i, fn, (active.get(fn) ?? 0) === 0);
    active.set(fn, (active.get(fn) ?? 0) + 1);
    open.push(i);
  }
}

/** What the pruning and the drawing work from: per-function times and the full caller/callee relation. */
interface Graph {
  model: ExecutionModel;
  view: TransformedView;
  runs: Uint32Array;
  /** Function ids at or above this are collapsed packages. */
  F: number;
  /** Larger than every function id, so `from * K + to` identifies an edge. */
  K: number;
  self: Map<number, number>;
  total: Map<number, number>;
  recursion: Map<number, number>;
  callers: Map<number, Set<number>>;
  callees: Map<number, Set<number>>;
  /** Every function with time, heaviest first. */
  all: number[];
  heavier: (a: number, b: number) => number;
}

function describeGraph(model: ExecutionModel, view: TransformedView): Graph {
  const tree = view.tree;
  const F = model.functions.length;
  const K = F + view.syntheticPackages.length + 1;
  const runs = runsPerNode(tree, view.samples);

  const self = new Map<number, number>();
  const total = new Map<number, number>();
  const recursion = new Map<number, number>();
  const edges = new Map<number, RawEdge>();
  forEachCall(tree, (i, fn, outermost) => {
    self.set(fn, (self.get(fn) ?? 0) + (tree.self[i] ?? 0));
    if (outermost) total.set(fn, (total.get(fn) ?? 0) + (tree.total[i] ?? 0));
    const parent = tree.parent[i] ?? 0;
    if (parent <= 0) return;
    const caller = tree.fn[parent] ?? 0;
    if (caller === fn) recursion.set(fn, (recursion.get(fn) ?? 0) + 1);
    else {
      // Nested (indirect recursion) calls add to the count but not the weight, so time is not doubled.
      const key = caller * K + fn;
      const e = edges.get(key) ?? { from: caller, to: fn, weight: 0, count: 0, hiddenFrames: 0 };
      if (outermost) e.weight += tree.total[i] ?? 0;
      e.count += runs[i] ?? 0;
      edges.set(key, e);
    }
  });

  const callers = new Map<number, Set<number>>();
  const callees = new Map<number, Set<number>>();
  for (const e of edges.values()) {
    (callees.get(e.from) ?? callees.set(e.from, new Set()).get(e.from))?.add(e.to);
    (callers.get(e.to) ?? callers.set(e.to, new Set()).get(e.to))?.add(e.from);
  }

  const heavier = (a: number, b: number): number =>
    (self.get(b) ?? 0) - (self.get(a) ?? 0) || (total.get(b) ?? 0) - (total.get(a) ?? 0) || a - b;
  const all = [...total.keys()].sort(heavier);
  return { model, view, runs, F, K, self, total, recursion, callers, callees, all, heavier };
}

/** Ego mode: the function, two callers up and two callees down, nearest first. */
function egoNeighbourhood(g: Graph, ego: number, maxNodes: number): Set<number> {
  const dist = new Map<number, number>([[ego, 0]]);
  const walk = (next: Map<number, Set<number>>): void => {
    let frontier = [ego];
    for (let level = 1; level <= 2; level++) {
      const found: number[] = [];
      for (const f of frontier) {
        for (const n of next.get(f) ?? []) {
          if (!dist.has(n)) {
            dist.set(n, level);
            found.push(n);
          }
        }
      }
      frontier = found;
    }
  };
  walk(g.callers);
  walk(g.callees);
  const ranked = [...dist.keys()].sort(
    (a, b) => (dist.get(a) ?? 0) - (dist.get(b) ?? 0) || g.heavier(a, b),
  );
  return new Set(ranked.slice(0, Math.max(1, maxNodes)));
}

/** The nodes that fill the coverage budget: the target's own big functions first, then the heaviest. */
function coveringNodes(
  g: Graph,
  options: CallGraphOptions,
  prioritize: boolean,
  maxNodes: number,
): Set<number> {
  const { model, view, self, total, all, F } = g;
  const totalUs = view.totalUs;
  const coverage = options.coverage ?? 0.8;
  const shown = new Set<number>();
  let cumulative = 0;
  if (prioritize) {
    const entry = model.tracks[view.trackIndex]?.rootFn;
    for (const f of all) {
      if (shown.size >= maxNodes) break;
      if (f >= F || f === entry || model.functions.origin[f] !== Origin.User) continue;
      const big = (total.get(f) ?? 0) >= 0.01 * totalUs || (self.get(f) ?? 0) >= 0.005 * totalUs;
      if (!big) continue;
      shown.add(f);
      cumulative += self.get(f) ?? 0;
    }
  }
  for (const f of all) {
    if (shown.size >= maxNodes || (totalUs > 0 && cumulative >= coverage * totalUs)) break;
    if (shown.has(f)) continue;
    shown.add(f);
    cumulative += self.get(f) ?? 0;
  }
  return shown;
}

/** The function drawn as the entry root: where every call starts; -1 in ego mode or when it has no time. */
function entryRoot(g: Graph, ego: number | undefined): number {
  const entryFn = g.model.tracks[g.view.trackIndex]?.rootFn;
  let entryShown = -1;
  if (ego === undefined && entryFn !== undefined) {
    const tree = g.view.tree;
    for (let c = 1; c < tree.length; c = tree.subtreeEnd[c] ?? c + 1) {
      if (tree.fn[c] === entryFn && g.total.has(entryFn)) entryShown = entryFn;
    }
  }
  return entryShown;
}

function graphNodes(
  g: Graph,
  shown: Set<number>,
  inHood: Set<number>,
  ego: number | undefined,
  entryShown: number,
): CallGraphNode[] {
  const { self, total, recursion, callers, callees, F } = g;
  const totalUs = g.view.totalUs;
  return [...shown]
    .sort((a, b) => (total.get(b) ?? 0) - (total.get(a) ?? 0) || a - b)
    .map((fn) => {
      const hidden = (set: Set<number> | undefined): number => {
        let n = 0;
        for (const f of set ?? []) if (!shown.has(f)) n++;
        return n;
      };
      return {
        fn,
        self: self.get(fn) ?? 0,
        total: total.get(fn) ?? 0,
        selfShare: totalUs > 0 ? (self.get(fn) ?? 0) / totalUs : 0,
        totalShare: totalUs > 0 ? (total.get(fn) ?? 0) / totalUs : 0,
        hiddenCallers: hidden(callers.get(fn)),
        hiddenCallees: hidden(callees.get(fn)),
        faded: ego !== undefined && !inHood.has(fn),
        recursion: recursion.get(fn) ?? 0,
        isPackage: fn >= F,
        isEntry: fn === entryShown,
      };
    });
}

/**
 * Drawn edges: each kept occurrence hangs off its nearest kept ancestor, so pruned frames in between
 * become one contracted edge instead of leaving the node without a caller.
 */
function drawnEdges(g: Graph, shown: Set<number>): RawEdge[] {
  const tree = g.view.tree;
  const drawn = new Map<number, RawEdge>();
  const nearest = new Int32Array(tree.length).fill(-1);
  forEachCall(tree, (i, fn, outermost) => {
    const p = tree.parent[i] ?? 0;
    const parentKept = p > 0 && shown.has(tree.fn[p] ?? 0);
    const anc = parentKept ? p : p > 0 ? (nearest[p] ?? -1) : -1;
    nearest[i] = anc;
    if (shown.has(fn) && anc > 0 && tree.fn[anc] !== fn) {
      const caller = tree.fn[anc] ?? 0;
      const key = caller * g.K + fn;
      const hidden = (tree.depth[i] ?? 0) - (tree.depth[anc] ?? 0) - 1;
      const e = drawn.get(key) ?? {
        from: caller,
        to: fn,
        weight: 0,
        count: 0,
        hiddenFrames: hidden,
      };
      if (outermost) e.weight += tree.total[i] ?? 0;
      e.count += g.runs[i] ?? 0;
      e.hiddenFrames = Math.min(e.hiddenFrames, hidden);
      drawn.set(key, e);
    }
  });
  return [...drawn.values()].sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Back edges: DFS from the heaviest callers-free nodes; an edge into a node on the stack closes a cycle. */
function backEdges(kept: RawEdge[], nodes: CallGraphNode[]): Set<RawEdge> {
  const out = new Map<number, RawEdge[]>();
  for (const e of kept) (out.get(e.from) ?? out.set(e.from, []).get(e.from))?.push(e);
  const hasCaller = new Set(kept.map((e) => e.to));
  const roots = [
    ...nodes.filter((n) => !hasCaller.has(n.fn)).map((n) => n.fn),
    ...nodes.filter((n) => hasCaller.has(n.fn)).map((n) => n.fn),
  ];
  const state = new Map<number, number>();
  const back = new Set<RawEdge>();
  const visit = (f: number): void => {
    state.set(f, 1);
    for (const e of out.get(f) ?? []) {
      const s = state.get(e.to) ?? 0;
      if (s === 1) back.add(e);
      else if (s === 0) visit(e.to);
    }
    state.set(f, 2);
  };
  for (const r of roots) if ((state.get(r) ?? 0) === 0) visit(r);
  return back;
}

export function callGraph(
  model: ExecutionModel,
  view: TransformedView,
  options: CallGraphOptions = {},
): CallGraph {
  const g = describeGraph(model, view);
  const prioritize = options.prioritizeTarget !== false;
  const maxNodes = options.maxNodes ?? (prioritize ? 40 : 25);
  const totalUs = view.totalUs;

  const ego = options.ego;
  const inHood =
    ego !== undefined && g.total.has(ego) ? egoNeighbourhood(g, ego, maxNodes) : new Set<number>();
  const shown =
    ego !== undefined && g.total.has(ego)
      ? new Set(inHood)
      : coveringNodes(g, options, prioritize, maxNodes);
  // The entry root is always drawn: it is where every call starts.
  const entryShown = entryRoot(g, ego);
  if (entryShown >= 0) shown.add(entryShown);
  for (const f of options.expanded ?? []) {
    if (!g.total.has(f)) continue;
    shown.add(f);
    for (const n of g.callers.get(f) ?? []) shown.add(n);
    for (const n of g.callees.get(f) ?? []) shown.add(n);
  }

  const nodes = graphNodes(g, shown, inHood, ego, entryShown);
  const kept = drawnEdges(g, shown);
  const back = backEdges(kept, nodes);
  const graphEdges: CallGraphEdge[] = kept.map((e) => ({
    from: e.from as ViewFnId,
    to: e.to as ViewFnId,
    weight: e.weight,
    share: totalUs > 0 ? e.weight / totalUs : 0,
    count: e.count,
    back: back.has(e),
    hiddenFrames: e.hiddenFrames,
  }));
  return { nodes, edges: graphEdges, hiddenNodes: g.all.length - shown.size, totalUs };
}
