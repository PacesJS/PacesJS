// Queries that answer "where is the time going" without a view: the dominant call chains, the hot
// functions of one dependency, and who calls a function. All read the model, not a view, except
// hot paths which fold plumbing and idle (and optionally other origins) through the transform layer.

import { Origin } from '../model.js';
import type { ExecutionModel, FnId, OriginId } from '../model.js';
import type {
  CallerNode,
  FunctionLocation,
  HotPath,
  HotPathOptions,
  PackageFunction,
  Transform,
} from './types.js';
import { applyTransforms } from './view.js';
import { trackAt } from './track-at.js';

const ALL_ORIGINS: OriginId[] = [
  Origin.User,
  Origin.Dependency,
  Origin.Framework,
  Origin.Node,
  Origin.Native,
  Origin.Idle,
  Origin.Gc,
];
const MAX_CALLERS_PER_LEVEL = 8;

function locate(model: ExecutionModel, fn: FnId): FunctionLocation {
  return {
    name: model.strings[model.functions.name[fn] ?? 0] ?? '',
    file: model.strings[model.functions.file[fn] ?? 0] ?? '',
    line: model.functions.line[fn] ?? 0,
  };
}

/**
 * Chains that end where no callee still carries `minShare` of busy time, ranked by total time.
 * The first chain is the dominant path; deeper forks follow.
 */
export function hotPaths(
  model: ExecutionModel,
  trackIndex: number,
  options: HotPathOptions = {},
): HotPath[] {
  trackAt(model, trackIndex);
  const limit = options.limit ?? 8;
  const minShare = options.minShare ?? 0.02;
  const stack: Transform[] = [
    { kind: 'stitch-continuations' },
    { kind: 'merge-plumbing' },
    { kind: 'drop-idle' },
  ];
  if (options.origin !== undefined) {
    stack.push({
      kind: 'hide-origins',
      origins: ALL_ORIGINS.filter((o) => o !== options.origin),
    });
  }
  const view = applyTransforms(model, trackIndex, stack);
  const tree = view.tree;
  const floor = view.totalUs * minShare;
  if (view.totalUs <= 0) return [];

  const rootFn = trackAt(model, trackIndex).rootFn;
  const terminals: number[] = [];
  for (let n = 1; n < tree.length; n++) {
    if ((tree.total[n] ?? 0) < floor) continue;
    let carried = false;
    const end = tree.subtreeEnd[n] ?? n + 1;
    for (let c = n + 1; c < end && !carried; c = tree.subtreeEnd[c] ?? c + 1) {
      carried = (tree.total[c] ?? 0) >= floor;
    }
    if (!carried) terminals.push(n);
  }
  terminals.sort((a, b) => (tree.total[b] ?? 0) - (tree.total[a] ?? 0) || a - b);

  return terminals
    .map((node): HotPath => {
      const fns: FnId[] = [];
      for (let n = node; n > 0; n = tree.parent[n] ?? 0) {
        // The run's entry root is not a function of the program.
        if (tree.fn[n] !== rootFn) fns.push(tree.fn[n] ?? 0);
      }
      fns.reverse();
      return {
        fns,
        locations: fns.map((fn) => locate(model, fn)),
        selfUs: tree.self[node] ?? 0,
        totalUs: tree.total[node] ?? 0,
        share: (tree.total[node] ?? 0) / view.totalUs,
      };
    })
    .filter((p) => p.fns.length > 0)
    .slice(0, limit);
}

/** The functions of one npm package on a track, hottest by self time first. */
export function packageBreakdown(
  model: ExecutionModel,
  trackIndex: number,
  pkg: string,
): PackageFunction[] {
  const track = trackAt(model, trackIndex);
  const out: PackageFunction[] = [];
  track.fnIds.forEach((fn, i) => {
    if ((model.strings[model.functions.pkg[fn] ?? 0] ?? '') !== pkg) return;
    out.push({
      fn,
      ...locate(model, fn),
      self: track.agg.fnSelf[i] ?? 0,
      total: track.agg.fnTotal[i] ?? 0,
    });
  });
  return out.sort((a, b) => b.self - a.self || b.total - a.total || a.fn - b.fn);
}

/** Who calls `fn`, heaviest first, followed up `depth` levels (recursion is cut). */
export function callersOf(
  model: ExecutionModel,
  trackIndex: number,
  fn: FnId,
  depth = 2,
): CallerNode[] {
  const track = trackAt(model, trackIndex);
  const edges = track.agg.edges;
  const root = track.callTree.fn[0];
  const byCallee = new Map<number, number[]>();
  for (let e = 0; e < edges.length; e++) {
    const callee = edges.callee[e] ?? 0;
    const list = byCallee.get(callee);
    if (list) list.push(e);
    else byCallee.set(callee, [e]);
  }
  const walk = (target: FnId, levels: number, path: Set<FnId>): CallerNode[] => {
    if (levels <= 0) return [];
    const list = (byCallee.get(target) ?? [])
      .filter((e) => edges.caller[e] !== root && edges.caller[e] !== target)
      .sort(
        (a, b) =>
          (edges.weight[b] ?? 0) - (edges.weight[a] ?? 0) ||
          (edges.caller[a] ?? 0) - (edges.caller[b] ?? 0),
      )
      .slice(0, MAX_CALLERS_PER_LEVEL);
    return list.map((e): CallerNode => {
      const caller = edges.caller[e] ?? 0;
      const next = new Set(path).add(caller);
      return {
        fn: caller,
        ...locate(model, caller),
        weightUs: edges.weight[e] ?? 0,
        calls: edges.count[e] ?? 0,
        callers: path.has(caller) ? [] : walk(caller, levels - 1, next),
      };
    });
  };
  return walk(fn, depth, new Set([fn]));
}
