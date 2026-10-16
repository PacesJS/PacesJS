import type { ExecutionModel, Track } from '@pacesjs/engine';
import type { Transform } from '../state/types';
import { ORIGIN_DEP, ORIGIN_IDLE, at, fnLocation, fnName, packageOf, str } from './access';

export interface TaskOption {
  index: number;
  label: string;
  startUs: number;
  durationUs: number;
  longest: boolean;
}

export function taskLabel(model: ExecutionModel, track: Track, i: number): string {
  const label = str(model, at(track.tasks.label, i));
  return label || 'task';
}

/** Longest tasks first, capped, for the task picker. */
export function taskOptions(model: ExecutionModel, track: Track, limit = 25): TaskOption[] {
  const tasks = track.tasks;
  const idx = Array.from({ length: tasks.length }, (_, i) => i);
  const dur = (i: number): number => at(tasks.end, i) - at(tasks.start, i);
  idx.sort((a, b) => dur(b) - dur(a) || a - b);
  return idx.slice(0, limit).map((i, rank) => ({
    index: i,
    label: taskLabel(model, track, i),
    startUs: at(tasks.start, i),
    durationUs: dur(i),
    longest: rank === 0,
  }));
}

export function longestTask(track: Track): number {
  let best = -1;
  let bestDur = -1;
  for (let i = 0; i < track.tasks.length; i++) {
    const d = at(track.tasks.end, i) - at(track.tasks.start, i);
    if (d > bestDur) {
      bestDur = d;
      best = i;
    }
  }
  return best;
}

export interface WaterfallRow {
  /** Index into the track's span table of the row's first (outermost) span. */
  span: number;
  fn: number;
  depth: number;
  name: string;
  loc: string;
  origin: number;
  /** Start and end in microseconds from the task start. */
  start: number;
  end: number;
  hasChildren: boolean;
  /** Plumbing or dependency frames folded into this row. */
  folded: number;
  critical: boolean;
  /** Shorter than two sampling intervals. */
  belowPrecision: boolean;
  share: number;
}

export interface WaterfallData {
  taskIndex: number;
  trackId: string;
  taskLabel: string;
  taskUs: number;
  taskStartUs: number;
  rows: WaterfallRow[];
  /** 0-based row indexes of the critical-path chain. */
  criticalRows: number[];
  hasAsync: boolean;
}

export interface WaterfallOptions {
  transforms: readonly Transform[];
  task: number;
}

/** Rows in execution order for one task, with plumbing merged and dependency packages folded. */
export function buildWaterfall(
  model: ExecutionModel,
  track: Track,
  opts: WaterfallOptions,
): WaterfallData | null {
  const taskIndex =
    opts.task >= 0 && opts.task < track.tasks.length ? opts.task : longestTask(track);
  if (taskIndex < 0) return null;
  const s = track.spans;
  const first = at(track.tasks.spanStart, taskIndex);
  const last = at(track.tasks.spanEnd, taskIndex);
  const t0 = at(track.tasks.start, taskIndex);
  const taskUs = Math.max(1, at(track.tasks.end, taskIndex) - t0);
  const mergePlumbing = opts.transforms.some((t) => t.k === 'merge-plumbing');
  const collapseAll = opts.transforms.some((t) => t.k === 'collapse-deps');
  const dropIdle = opts.transforms.some((t) => t.k === 'drop-idle');
  const mergedFns = new Set(opts.transforms.flatMap((t) => (t.k === 'merge-fn' ? [t.fn] : [])));
  const collapsedPkgs = new Set(
    opts.transforms.flatMap((t) => (t.k === 'collapse-pkg' ? [t.pkg] : [])),
  );
  const fnOrigin = model.functions.origin;

  const pkgIfCollapsed = (fn: number): string => {
    const pkg = packageOf(model, fn);
    if (!pkg) return '';
    if (collapsedPkgs.has(pkg)) return pkg;
    return collapseAll && at(fnOrigin, fn) === ORIGIN_DEP ? pkg : '';
  };

  // keep[i]: whether span i becomes a row; owner[i]: the kept span that absorbs it.
  const owner = new Map<number, number>();
  const folded = new Map<number, number>();
  const rowOf = new Map<number, number>();
  const rows: WaterfallRow[] = [];
  const depthOf = new Map<number, number>();

  const rowParentSpan = new Map<number, number>();
  const lastChild = new Map<number, number>();

  for (let i = first; i < last; i++) {
    const fn = at(s.fn, i);
    const par = s.parent[i] ?? -1;
    const parentOwner = par >= first ? (rowOf.has(par) ? par : (owner.get(par) ?? -1)) : -1;
    if (dropIdle && at(fnOrigin, fn) === ORIGIN_IDLE) {
      owner.set(i, parentOwner);
      continue;
    }
    const plumb = mergePlumbing && at(model.functions.plumbing, fn) === 1;
    const merged = mergedFns.has(fn);
    const pkg = pkgIfCollapsed(fn);
    const sameParentPkg =
      pkg !== '' && parentOwner >= 0 && pkgIfCollapsed(at(s.fn, parentOwner)) === pkg;
    const sibling = lastChild.get(parentOwner);
    if (pkg !== '' && sibling !== undefined && pkgIfCollapsed(at(s.fn, sibling)) === pkg) {
      const row = rows[rowOf.get(sibling) ?? -1];
      if (row) {
        owner.set(i, sibling);
        row.end = Math.max(row.end, at(s.end, i) - t0);
        row.share = (row.end - row.start) / taskUs;
        row.belowPrecision = row.end - row.start < 2 * model.meta.intervalUs;
        folded.set(sibling, (folded.get(sibling) ?? 0) + 1);
        continue;
      }
    }
    if ((plumb || merged || sameParentPkg) && parentOwner >= 0) {
      owner.set(i, parentOwner);
      if (sameParentPkg || plumb || merged)
        folded.set(parentOwner, (folded.get(parentOwner) ?? 0) + 1);
      continue;
    }
    const d = parentOwner >= 0 ? (depthOf.get(parentOwner) ?? 0) + 1 : 0;
    depthOf.set(i, d);
    rowParentSpan.set(i, parentOwner);
    lastChild.set(parentOwner, i);
    rowOf.set(i, rows.length);
    const label = pkg ? `${pkg} ▸ ${fnName(model, fn)}` : fnName(model, fn);
    rows.push({
      span: i,
      fn,
      depth: depthOf.get(i) ?? 0,
      name: label,
      loc: pkg ? '' : fnLocation(model, fn),
      origin: pkg ? ORIGIN_DEP : at(fnOrigin, fn),
      start: at(s.start, i) - t0,
      end: at(s.end, i) - t0,
      hasChildren: false,
      folded: 0,
      critical: false,
      belowPrecision: at(s.end, i) - at(s.start, i) < 2 * model.meta.intervalUs,
      share: (at(s.end, i) - at(s.start, i)) / taskUs,
    });
  }

  // Parent row bookkeeping: children flags, folded counts, critical path.
  const parentRow = new Int32Array(rows.length).fill(-1);
  rows.forEach((r, ri) => {
    const par = rowParentSpan.get(r.span) ?? -1;
    const pr = par >= 0 ? (rowOf.get(par) ?? -1) : -1;
    parentRow[ri] = pr;
    if (pr >= 0) (rows[pr] as WaterfallRow).hasChildren = true;
  });
  folded.forEach((count, spanIdx) => {
    const ri = rowOf.get(spanIdx);
    if (ri !== undefined) (rows[ri] as WaterfallRow).folded = count;
  });

  const kids = new Map<number, number[]>();
  for (let ri = 0; ri < rows.length; ri++) {
    const p = parentRow[ri] ?? -1;
    const list = kids.get(p) ?? [];
    list.push(ri);
    kids.set(p, list);
  }
  const widest = (list: number[]): number =>
    list.reduce(
      (best, ri) =>
        (rows[ri] as WaterfallRow).end - (rows[ri] as WaterfallRow).start >
        (rows[best] as WaterfallRow).end - (rows[best] as WaterfallRow).start
          ? ri
          : best,
      list[0] as number,
    );
  const criticalRows: number[] = [];
  let level = kids.get(-1) ?? [];
  while (level.length > 0) {
    const w = widest(level);
    (rows[w] as WaterfallRow).critical = true;
    criticalRows.push(w);
    level = kids.get(w) ?? [];
  }

  return {
    taskIndex,
    trackId: track.id,
    taskLabel: taskLabel(model, track, taskIndex),
    taskUs,
    taskStartUs: t0,
    rows,
    criticalRows,
    hasAsync: track.asyncEdges.length > 0,
  };
}

/** Rows hidden because an ancestor row is collapsed. Returns visible row indexes. */
export function visibleRows(rows: WaterfallRow[], collapsed: ReadonlySet<number>): number[] {
  const out: number[] = [];
  let hideBelow = Infinity;
  rows.forEach((r, i) => {
    if (r.depth > hideBelow) return;
    hideBelow = Infinity;
    out.push(i);
    if (collapsed.has(i)) hideBelow = r.depth;
  });
  return out;
}
