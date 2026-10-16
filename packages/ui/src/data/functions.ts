import type { ExecutionModel, Track } from '@pacesjs/engine';
import type { TimeRange } from '../state/types';
import { ORIGIN_DEP, at, fnLocation, str } from './access';
import { functionTotals, isPlaceholder, viewFnName, viewFnOrigin, viewFnPkg } from './tview';
import type { TView } from './tview';

export interface CallCounts {
  perFn: Float64Array;
  perPkg: Map<string, number>;
}

/** Call-count estimates: reconstructed spans that start inside the range. Sampled, so always "est.". */
export function callCounts(
  model: ExecutionModel,
  tracks: Track[],
  range: TimeRange | null,
): CallCounts {
  const perFn = new Float64Array(model.functions.length);
  const perPkg = new Map<string, number>();
  for (const track of tracks) {
    const s = track.spans;
    if (!range && track.agg.fnCalls.length === track.fnIds.length) {
      // Whole run: the engine's own estimate (contiguous runs seen in the samples).
      for (let k = 0; k < track.fnIds.length; k++) {
        const f = at(track.fnIds, k);
        perFn[f] = (perFn[f] ?? 0) + at(track.agg.fnCalls, k);
      }
      for (let i = 0; i < s.length; i++) addPkgCall(model, s, i, perPkg);
      continue;
    }
    for (let i = 0; i < s.length; i++) {
      const start = at(s.start, i);
      if (range && (start < range[0] || start >= range[1])) continue;
      const f = at(s.fn, i);
      perFn[f] = (perFn[f] ?? 0) + 1;
      addPkgCall(model, s, i, perPkg);
    }
  }
  return { perFn, perPkg };
}

/** Count a call into a package when the caller span belongs to a different package. */
function addPkgCall(
  model: ExecutionModel,
  s: Track['spans'],
  i: number,
  perPkg: Map<string, number>,
): void {
  const f = at(s.fn, i);
  if (at(model.functions.origin, f) !== ORIGIN_DEP) return;
  const pkg = str(model, at(model.functions.pkg, f));
  const par = s.parent[i] ?? -1;
  const parentPkg =
    par >= 0 && at(model.functions.origin, at(s.fn, par)) === ORIGIN_DEP
      ? str(model, at(model.functions.pkg, at(s.fn, par)))
      : '';
  if (pkg && pkg !== parentPkg) perPkg.set(pkg, (perPkg.get(pkg) ?? 0) + 1);
}

export function callsOf(t: TView, counts: CallCounts, model: ExecutionModel, fn: number): number {
  if (!isPlaceholder(t, fn)) return at(counts.perFn, fn);
  return counts.perPkg.get(viewFnPkg(model, t, fn)) ?? 0;
}

export interface FnRow {
  fn: number;
  name: string;
  origin: number;
  pkg: string;
  selfUs: number;
  totalUs: number;
  /** Fraction of the base (range wall time across the selected tracks). */
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

export function baseTimeUs(tracks: Track[], range: TimeRange | null): number {
  const span = range ? range[1] - range[0] : Math.max(0, ...tracks.map((t) => t.durationUs));
  return span * Math.max(1, tracks.length);
}

export function functionsTable(
  model: ExecutionModel,
  t: TView,
  tracks: Track[],
  range: TimeRange | null,
  filter = '',
): FunctionsResult {
  const totals = functionTotals(t);
  const counts = callCounts(model, tracks, range);
  const base = baseTimeUs(tracks, range) || 1;
  const q = filter.trim().toLowerCase();
  const rows: FnRow[] = [];
  let totalFns = 0;
  for (let f = 0; f < totals.self.length; f++) {
    const self = at(totals.self, f);
    const total = at(totals.total, f);
    if (total <= 0 && self <= 0) continue;
    totalFns++;
    const name = viewFnName(model, t, f);
    const pkg = viewFnPkg(model, t, f);
    const loc = isPlaceholder(t, f) ? `node_modules/${pkg}` : fnLocation(model, f);
    if (q && !`${name} ${loc} ${pkg}`.toLowerCase().includes(q)) continue;
    rows.push({
      fn: f,
      name,
      origin: viewFnOrigin(model, t, f),
      pkg,
      selfUs: self,
      totalUs: total,
      share: self / base,
      calls: callsOf(t, counts, model, f),
      loc,
    });
  }
  rows.sort((a, b) => b.selfUs - a.selfUs || a.name.localeCompare(b.name) || a.fn - b.fn);
  return { rows, totalFns, baseUs: base };
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

/** Outermost nodes of a function (nested recursion is counted once). */
export function outermostNodes(t: TView, fn: number): number[] {
  const out: number[] = [];
  let skipUntil = 0;
  for (let i = 0; i < t.length; i++) {
    if (i < skipUntil) continue;
    if (t.fn[i] === fn) {
      out.push(i);
      skipUntil = t.subtreeEnd[i] ?? i + 1;
    }
  }
  return out;
}

export function functionDetails(
  model: ExecutionModel,
  t: TView,
  tracks: Track[],
  range: TimeRange | null,
  fn: number,
): Details | null {
  const nodes = outermostNodes(t, fn);
  const totals = functionTotals(t);
  const total = at(totals.total, fn);
  if (nodes.length === 0 && total <= 0) return null;
  const callers = new Map<number, number>();
  const callees = new Map<number, number>();
  let selfAll = 0;
  for (const n of nodes) {
    const par = t.parent[n] ?? -1;
    const key = par >= 0 ? (t.fn[par] ?? 0) : -1;
    callers.set(key, (callers.get(key) ?? 0) + (t.total[n] ?? 0));
    const end = t.subtreeEnd[n] ?? n + 1;
    for (let c = n + 1; c < end; c = t.subtreeEnd[c] ?? c + 1) {
      const cf = t.fn[c] ?? 0;
      callees.set(cf, (callees.get(cf) ?? 0) + (t.total[c] ?? 0));
    }
    selfAll += t.self[n] ?? 0;
  }
  const denom = total || 1;
  const rel = (m: Map<number, number>, kind: 'caller' | 'callee'): RelatedRow[] =>
    [...m.entries()]
      .map(([f, v]) => ({
        fn: f < 0 ? null : f,
        name: f < 0 ? '(root)' : viewFnName(model, t, f),
        origin: f < 0 ? 4 : viewFnOrigin(model, t, f),
        frac: v / denom,
        kind,
      }))
      .sort((a, b) => b.frac - a.frac || a.name.localeCompare(b.name));
  const calleeRows = rel(callees, 'callee').filter((r) => r.fn !== fn);
  const topCallees = calleeRows.slice(0, 6);
  const selfRow: RelatedRow = {
    fn: null,
    name: 'self',
    origin: -1,
    frac: selfAll / denom,
    kind: 'self',
  };
  const merged = [...topCallees, selfRow].sort((a, b) => b.frac - a.frac);
  const counts = callCounts(model, tracks, range);
  return {
    fn,
    name: viewFnName(model, t, fn),
    loc: isPlaceholder(t, fn) ? `node_modules/${viewFnPkg(model, t, fn)}` : fnLocation(model, fn),
    origin: viewFnOrigin(model, t, fn),
    pkg: viewFnPkg(model, t, fn),
    totalUs: total,
    selfUs: at(totals.self, fn),
    share: total / (baseTimeUs(tracks, range) || 1),
    calls: callsOf(t, counts, model, fn),
    callers: rel(callers, 'caller').slice(0, 6),
    callees: merged,
  };
}

export interface SandwichRow {
  /** Negative = callers above, 0 = the function, positive = callees below. */
  level: number;
  name: string;
  origin: number;
  fn: number | null;
  /** Fractions of the function's total time. */
  start: number;
  end: number;
  isSelf: boolean;
}

/** Inverted callers above, merged callees below, widths as a share of the function's total. */
export function sandwich(model: ExecutionModel, t: TView, fn: number, maxDepth = 3): SandwichRow[] {
  const nodes = outermostNodes(t, fn);
  const total = nodes.reduce((a, n) => a + (t.total[n] ?? 0), 0);
  if (total <= 0) return [];
  const rows: SandwichRow[] = [];
  const origin = (f: number): number => viewFnOrigin(model, t, f);
  const name = (f: number): string => viewFnName(model, t, f);

  // Callers: merge ancestor chains by function, level by level.
  let groups: Array<{ fn: number; weight: number; nodes: number[] }> = [
    { fn: -2, weight: total, nodes },
  ];
  for (let level = -1; level >= -maxDepth; level--) {
    const next = new Map<number, { fn: number; weight: number; nodes: number[] }>();
    for (const g of groups) {
      for (const n of g.nodes) {
        const par = t.parent[n] ?? -1;
        if (par < 0) continue;
        const f = t.fn[par] ?? 0;
        const hit = next.get(f) ?? { fn: f, weight: 0, nodes: [] };
        hit.weight += t.total[n] ?? 0;
        hit.nodes.push(par);
        next.set(f, hit);
      }
    }
    groups = [...next.values()].sort((a, b) => b.weight - a.weight);
    if (groups.length === 0) break;
    let x = 0;
    for (const g of groups) {
      const w = g.weight / total;
      rows.push({
        level,
        name: name(g.fn),
        origin: origin(g.fn),
        fn: g.fn,
        start: x,
        end: x + w,
        isSelf: false,
      });
      x += w;
    }
  }

  rows.push({ level: 0, name: name(fn), origin: origin(fn), fn, start: 0, end: 1, isSelf: false });

  // Callees: merge descendants by function path.
  interface Group {
    fn: number;
    weight: number;
    nodes: number[];
  }
  const kids = (nodeList: number[]): Group[] => {
    const m = new Map<number, Group>();
    for (const n of nodeList) {
      const end = t.subtreeEnd[n] ?? n + 1;
      for (let c = n + 1; c < end; c = t.subtreeEnd[c] ?? c + 1) {
        const f = t.fn[c] ?? 0;
        const g = m.get(f) ?? { fn: f, weight: 0, nodes: [] };
        g.weight += t.total[c] ?? 0;
        g.nodes.push(c);
        m.set(f, g);
      }
    }
    return [...m.values()].sort(
      (a, b) => b.weight - a.weight || name(a.fn).localeCompare(name(b.fn)),
    );
  };
  const place = (nodeList: number[], level: number, from: number, scale: number): void => {
    if (level > maxDepth - 1) return;
    let x = from;
    for (const g of kids(nodeList)) {
      const w = (g.weight / total) * scale;
      if (w < 0.004) continue;
      rows.push({
        level,
        name: name(g.fn),
        origin: origin(g.fn),
        fn: g.fn,
        start: x,
        end: x + w,
        isSelf: false,
      });
      place(g.nodes, level + 1, x, 1);
      x += w;
    }
  };
  place(nodes, 1, 0, 1);
  const selfFrac = nodes.reduce((a, n) => a + (t.self[n] ?? 0), 0) / total;
  const childEnd = rows.filter((r) => r.level === 1).reduce((a, r) => Math.max(a, r.end), 0);
  if (selfFrac > 0) {
    rows.push({
      level: 1,
      name: 'self',
      origin: -1,
      fn: null,
      start: childEnd,
      end: Math.min(1, childEnd + selfFrac),
      isSelf: true,
    });
  }
  return rows;
}
