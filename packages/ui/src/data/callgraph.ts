import type { ExecutionModel, Track } from '@pacesjs/engine';
import type { TimeRange } from '../state/types';
import { at, fnLocation } from './access';
import { callCounts, callsOf } from './functions';
import { functionTotals, isPlaceholder, viewFnName, viewFnOrigin } from './tview';
import type { TView } from './tview';

export const PRUNE_SHARE = 0.8;
export const PRUNE_CAP = 25;

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
  hiddenCallerIds: number[];
  hiddenCalleeIds: number[];
  /** Members of a collapsed package (count), for the "+N" expand chip. */
  members: number;
}

export interface CgEdge {
  from: number;
  to: number;
  timeUs: number;
  /** Share of the caller's total time. */
  share: number;
  calls: number;
}

export interface CallGraphData {
  nodes: CgNode[];
  edges: CgEdge[];
  /** Recursion loops: function -> number of recursive frames. */
  loops: Array<{ fn: number; count: number }>;
  shownFns: number;
  totalFns: number;
  maxSelfUs: number;
  maxTotalUs: number;
  maxEdgeUs: number;
}

export interface CallGraphOptions {
  /** Show every function instead of pruning. */
  all: boolean;
  /** Functions revealed through "+N" chips. */
  reveal: number[];
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

export function buildCallGraph(
  model: ExecutionModel,
  t: TView,
  tracks: Track[],
  range: TimeRange | null,
  opts: CallGraphOptions,
): CallGraphData {
  const totals = functionTotals(t);
  const counts = callCounts(model, tracks, range);
  const fnLen = totals.self.length;

  // Edges and loops over the transformed tree; nested recursion is not double counted.
  const edgeMap = new Map<number, CgEdge>();
  const loopMap = new Map<number, number>();
  const callers = new Map<number, Set<number>>();
  const callees = new Map<number, Set<number>>();
  for (let i = 0; i < t.length; i++) {
    const p = t.parent[i] ?? -1;
    if (p < 0) continue;
    const f = t.fn[i] ?? 0;
    const pf = t.fn[p] ?? 0;
    if (f === pf) {
      loopMap.set(f, (loopMap.get(f) ?? 0) + 1);
      continue;
    }
    let nested = false;
    for (let a = p; a >= 0; a = t.parent[a] ?? -1) {
      if (t.fn[a] === f) {
        nested = true;
        break;
      }
    }
    if (nested) continue;
    const key = pf * fnLen + f;
    const e = edgeMap.get(key) ?? { from: pf, to: f, timeUs: 0, share: 0, calls: 0 };
    e.timeUs += t.total[i] ?? 0;
    edgeMap.set(key, e);
    (callers.get(f) ?? callers.set(f, new Set()).get(f))?.add(pf);
    (callees.get(pf) ?? callees.set(pf, new Set()).get(pf))?.add(f);
  }

  const present: number[] = [];
  for (let f = 0; f < fnLen; f++)
    if (at(totals.total, f) > 0 || at(totals.self, f) > 0) present.push(f);
  const byTotalDesc = (a: number, b: number): number =>
    at(totals.total, b) - at(totals.total, a) || a - b;

  const shown = new Set<number>();
  if (opts.all) {
    present.sort(byTotalDesc);
    present.slice(0, 200).forEach((f) => shown.add(f));
  } else {
    const bySelf = present.slice().sort((a, b) => at(totals.self, b) - at(totals.self, a) || a - b);
    const sumSelf = bySelf.reduce((a, f) => a + at(totals.self, f), 0) || 1;
    let acc = 0;
    for (const f of bySelf) {
      if (shown.size >= PRUNE_CAP || acc / sumSelf >= PRUNE_SHARE) break;
      shown.add(f);
      acc += at(totals.self, f);
    }
    // Keep each shown function connected upward through its heaviest caller.
    for (const f of [...shown]) {
      let cur = f;
      for (let guard = 0; guard < 64; guard++) {
        const cs = [...(callers.get(cur) ?? [])].filter((c) => c !== cur);
        if (cs.length === 0 || cs.some((c) => shown.has(c))) break;
        cs.sort(
          (a, b) =>
            (edgeMap.get(b * fnLen + cur)?.timeUs ?? 0) -
            (edgeMap.get(a * fnLen + cur)?.timeUs ?? 0),
        );
        const best = cs[0] as number;
        shown.add(best);
        cur = best;
      }
    }
  }
  for (const f of opts.reveal) if (at(totals.total, f) > 0 || at(totals.self, f) > 0) shown.add(f);

  const order = [...shown].sort(byTotalDesc);
  const nodes: CgNode[] = order.map((f) => {
    const placeholder = isPlaceholder(t, f);
    const origin = viewFnOrigin(model, t, f);
    const loc = placeholder ? 'package' : origin === 0 || origin === 1 ? fnLocation(model, f) : '';
    const sub = placeholder
      ? 'package'
      : loc
        ? baseName(loc)
        : origin === 3
          ? 'node'
          : origin === 4
            ? 'native'
            : origin === 6
              ? 'V8'
              : '';
    const hcIds = [...(callers.get(f) ?? [])].filter((c) => !shown.has(c));
    const heIds = [...(callees.get(f) ?? [])].filter((c) => !shown.has(c));
    const hc = hcIds.length;
    const he = heIds.length;
    return {
      fn: f,
      name: viewFnName(model, t, f),
      sub,
      origin,
      isPackage: placeholder,
      selfUs: at(totals.self, f),
      totalUs: at(totals.total, f),
      hiddenCallers: hc,
      hiddenCallees: he,
      hiddenCallerIds: hcIds,
      hiddenCalleeIds: heIds,
      members: placeholder ? packageMemberCount(model, viewFnName(model, t, f)) : 0,
    };
  });
  const edges: CgEdge[] = [];
  for (const e of edgeMap.values()) {
    if (!shown.has(e.from) || !shown.has(e.to)) continue;
    const callerTotal = at(totals.total, e.from) || 1;
    const calleeTotal = at(totals.total, e.to) || 1;
    edges.push({
      from: e.from,
      to: e.to,
      timeUs: e.timeUs,
      share: e.timeUs / callerTotal,
      calls: Math.round((callsOf(t, counts, model, e.to) * e.timeUs) / calleeTotal),
    });
  }
  edges.sort((a, b) => a.from - b.from || a.to - b.to);
  return {
    nodes,
    edges,
    loops: [...loopMap.entries()]
      .filter(([f]) => shown.has(f))
      .map(([fn, count]) => ({ fn, count })),
    shownFns: shown.size,
    totalFns: present.length,
    maxSelfUs: Math.max(1, ...nodes.map((n) => n.selfUs)),
    maxTotalUs: Math.max(1, ...nodes.map((n) => n.totalUs)),
    maxEdgeUs: Math.max(1, ...edges.map((e) => e.timeUs)),
  };
}

/** Number of functions a collapsed package stands for, estimated from the untransformed model. */
export function packageMemberCount(model: ExecutionModel, pkg: string): number {
  let n = 0;
  for (let f = 0; f < model.functions.length; f++) {
    if ((model.strings[at(model.functions.pkg, f)] ?? '') === pkg) n++;
  }
  return n;
}
