// Pass 8: aggregation. Self and total time per function, per call edge, per source line, per
// package and per task kind, from the call tree, the spans and V8's line ticks.

import { Origin, TASK_KIND_NAMES } from '../model.js';
import { compareText } from '../util/compare.js';
import type {
  CallTree,
  EdgeTable,
  LineTicks,
  PackageTable,
  Samples,
  SpanTable,
  TaskKindStats,
  TaskTable,
  TrackAggregates,
} from '../model.js';

export interface AggregateFunctions {
  length: number;
  origin: Uint8Array;
  pkg: Uint32Array;
  plumbing: Uint8Array;
  /** Module loading is plumbing for display but not an async cost. */
  loader: Uint8Array;
}

export interface TrackAggregateInput {
  tree: CallTree;
  samples: Samples;
  spans: SpanTable;
  tasks: TaskTable;
  taskSampleStart: Uint32Array;
  taskSampleEnd: Uint32Array;
  /** Tick entries per tree node (CSR) with their original lines. */
  tickOffset: Uint32Array;
  tickLine: Uint32Array;
  tickCount: Uint32Array;
  /** Samples that landed on each node. */
  hits: Uint32Array;
  functions: AggregateFunctions;
}

export interface TrackAggregateResult {
  agg: TrackAggregates;
  lines: LineTicks;
  fnIds: Uint32Array;
  busyUs: number;
  /** Self and total time per package string id, for the whole-run table. */
  pkgSelf: Map<number, number>;
  pkgTotal: Map<number, number>;
  kindCount: Uint32Array;
  kindBusy: Float64Array;
  kindPlumbing: Float64Array;
}

export function aggregateTrack(input: TrackAggregateInput): TrackAggregateResult {
  const { tree, spans, tasks, functions } = input;
  const F = functions.length;
  const self = new Float64Array(F);
  const total = new Float64Array(F);
  const calls = new Uint32Array(F);
  const present = new Uint8Array(F);
  const active = new Int32Array(F);
  const activePkg = new Map<number, number>();
  const pkgSelf = new Map<number, number>();
  const pkgTotal = new Map<number, number>();
  const edgeIndex = new Map<number, number>();
  const edgeCaller: number[] = [];
  const edgeCallee: number[] = [];
  const edgeWeight: number[] = [];
  const edgeCount: number[] = [];
  let busyUs = 0;

  const edgeFor = (caller: number, callee: number): number => {
    const key = caller * F + callee;
    let e = edgeIndex.get(key);
    if (e === undefined) {
      e = edgeCaller.length;
      edgeIndex.set(key, e);
      edgeCaller.push(caller);
      edgeCallee.push(callee);
      edgeWeight.push(0);
      edgeCount.push(0);
    }
    return e;
  };

  const open: number[] = [];
  for (let i = 0; i < tree.length; i++) {
    while (open.length > 0 && (tree.subtreeEnd[open[open.length - 1] ?? 0] ?? 0) <= i) {
      const done = open.pop() ?? 0;
      const f = tree.fn[done] ?? 0;
      active[f] = (active[f] ?? 1) - 1;
      const p = functions.pkg[f] ?? 0;
      if (p !== 0) activePkg.set(p, (activePkg.get(p) ?? 1) - 1);
    }
    const f = tree.fn[i] ?? 0;
    const p = functions.pkg[f] ?? 0;
    present[f] = 1;
    self[f] = (self[f] ?? 0) + (tree.self[i] ?? 0);
    if ((functions.origin[f] ?? 0) !== Origin.Idle) busyUs += tree.self[i] ?? 0;
    const parent = tree.parent[i] ?? -1;
    const recursive = (active[f] ?? 0) > 0;
    if (!recursive) total[f] = (total[f] ?? 0) + (tree.total[i] ?? 0);
    if (parent >= 0) {
      const caller = tree.fn[parent] ?? 0;
      if (!recursive || caller === f) {
        const e = edgeFor(caller, f);
        edgeWeight[e] = (edgeWeight[e] ?? 0) + (tree.total[i] ?? 0);
      }
    }
    if (p !== 0) {
      pkgSelf.set(p, (pkgSelf.get(p) ?? 0) + (tree.self[i] ?? 0));
      if ((activePkg.get(p) ?? 0) === 0)
        pkgTotal.set(p, (pkgTotal.get(p) ?? 0) + (tree.total[i] ?? 0));
      activePkg.set(p, (activePkg.get(p) ?? 0) + 1);
    }
    active[f] = (active[f] ?? 0) + 1;
    open.push(i);
  }

  for (let s = 0; s < spans.length; s++) {
    const f = spans.fn[s] ?? 0;
    calls[f] = (calls[f] ?? 0) + 1;
    const p = spans.parent[s] ?? -1;
    if (p >= 0) {
      const e = edgeFor(spans.fn[p] ?? 0, f);
      edgeCount[e] = (edgeCount[e] ?? 0) + 1;
    }
  }

  const ids: number[] = [];
  for (let f = 0; f < F; f++) if (present[f]) ids.push(f);
  const fnIds = Uint32Array.from(ids);
  const order = edgeCaller
    .map((_, e) => e)
    .sort(
      (a, b) =>
        (edgeCaller[a] ?? 0) - (edgeCaller[b] ?? 0) || (edgeCallee[a] ?? 0) - (edgeCallee[b] ?? 0),
    );
  const edges: EdgeTable = {
    length: order.length,
    caller: Uint32Array.from(order, (e) => edgeCaller[e] ?? 0),
    callee: Uint32Array.from(order, (e) => edgeCallee[e] ?? 0),
    weight: Float64Array.from(order, (e) => edgeWeight[e] ?? 0),
    count: Uint32Array.from(order, (e) => edgeCount[e] ?? 0),
  };

  // Line ticks: a node's self time is split over its tick lines in proportion to the ticks.
  const perFn: Array<Map<number, number> | undefined> = new Array<Map<number, number> | undefined>(
    F,
  );
  for (let n = 0; n < tree.length; n++) {
    const a = input.tickOffset[n] ?? 0;
    const b = input.tickOffset[n + 1] ?? 0;
    const hits = input.hits[n] ?? 0;
    if (a === b || hits === 0) continue;
    const perTick = (tree.self[n] ?? 0) / hits;
    const f = tree.fn[n] ?? 0;
    let m = perFn[f];
    if (!m) {
      m = new Map();
      perFn[f] = m;
    }
    for (let i = a; i < b; i++) {
      const line = input.tickLine[i] ?? 0;
      m.set(line, (m.get(line) ?? 0) + (input.tickCount[i] ?? 0) * perTick);
    }
  }
  const offset = new Uint32Array(F + 1);
  const lineList: number[] = [];
  const selfList: number[] = [];
  for (let f = 0; f < F; f++) {
    offset[f] = lineList.length;
    const m = perFn[f];
    if (!m) continue;
    for (const line of [...m.keys()].sort((x, y) => x - y)) {
      lineList.push(line);
      selfList.push(m.get(line) ?? 0);
    }
  }
  offset[F] = lineList.length;

  // Task kinds.
  const kindCount = new Uint32Array(TASK_KIND_NAMES.length);
  const kindBusy = new Float64Array(TASK_KIND_NAMES.length);
  const kindPlumbing = new Float64Array(TASK_KIND_NAMES.length);
  for (let k = 0; k < tasks.length; k++) {
    const kind = tasks.kind[k] ?? 6;
    kindCount[kind] = (kindCount[kind] ?? 0) + 1;
    kindBusy[kind] = (kindBusy[kind] ?? 0) + (tasks.busy[k] ?? 0);
    for (let i = input.taskSampleStart[k] ?? 0; i < (input.taskSampleEnd[k] ?? 0); i++) {
      const leaf = tree.fn[input.samples.node[i] ?? 0] ?? 0;
      if ((functions.plumbing[leaf] ?? 0) === 1 && (functions.loader[leaf] ?? 0) === 0) {
        kindPlumbing[kind] = (kindPlumbing[kind] ?? 0) + (input.samples.dur[i] ?? 0);
      }
    }
  }

  return {
    agg: {
      fnSelf: Float64Array.from(fnIds, (f) => self[f] ?? 0),
      fnTotal: Float64Array.from(fnIds, (f) => total[f] ?? 0),
      fnCalls: Uint32Array.from(fnIds, (f) => calls[f] ?? 0),
      edges,
    },
    lines: { offset, line: Uint32Array.from(lineList), self: Float64Array.from(selfList) },
    fnIds,
    busyUs,
    pkgSelf,
    pkgTotal,
    kindCount,
    kindBusy,
    kindPlumbing,
  };
}

export function mergePackages(
  results: TrackAggregateResult[],
  strings: string[],
): { packages: PackageTable; taskKinds: TaskKindStats } {
  const self = new Map<number, number>();
  const total = new Map<number, number>();
  const taskKinds: TaskKindStats = {
    count: new Uint32Array(TASK_KIND_NAMES.length),
    busy: new Float64Array(TASK_KIND_NAMES.length),
    plumbing: new Float64Array(TASK_KIND_NAMES.length),
  };
  for (const r of results) {
    for (const [p, v] of r.pkgSelf) self.set(p, (self.get(p) ?? 0) + v);
    for (const [p, v] of r.pkgTotal) total.set(p, (total.get(p) ?? 0) + v);
    for (let k = 0; k < TASK_KIND_NAMES.length; k++) {
      taskKinds.count[k] = (taskKinds.count[k] ?? 0) + (r.kindCount[k] ?? 0);
      taskKinds.busy[k] = (taskKinds.busy[k] ?? 0) + (r.kindBusy[k] ?? 0);
      taskKinds.plumbing[k] = (taskKinds.plumbing[k] ?? 0) + (r.kindPlumbing[k] ?? 0);
    }
  }
  const ids = [...new Set([...self.keys(), ...total.keys()])].sort(
    (a, b) =>
      (total.get(b) ?? 0) - (total.get(a) ?? 0) ||
      compareText(strings[a] ?? '', strings[b] ?? '') ||
      a - b,
  );
  return {
    packages: {
      length: ids.length,
      name: Uint32Array.from(ids),
      self: Float64Array.from(ids, (p) => self.get(p) ?? 0),
      total: Float64Array.from(ids, (p) => total.get(p) ?? 0),
    },
    taskKinds,
  };
}
