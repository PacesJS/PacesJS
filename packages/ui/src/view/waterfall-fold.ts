import { Origin } from '@pacesjs/engine';
import type { WaterfallRow } from '../data/types';

// Presentation folds over the engine's waterfall rows: sub-precision rows and Node's own
// bootstrap become one collapsed row each, and the first screen opens along the critical path.
// Folds are synthetic parent rows (negative ids) that start collapsed; opening one reveals the
// rows it stands for, so nothing is ever dropped.

/** Rows shorter than the measurement precision and under this share of the run are noise. */
export const NOISE_SHARE = 0.001;

/** Expand along the heaviest chain this deep, or until a row carries less than `MIN_PATH_SHARE`. */
export const INITIAL_DEPTH = 12;
const MIN_PATH_SHARE = 0.05;

export interface FoldOptions {
  /** Hide rows below precision and `NOISE_SHARE` behind one summary row per run of siblings. */
  hideSmall: boolean;
  /** Fold the leading Node and native frames before the first user frame into "node bootstrap". */
  bootstrap: boolean;
  /**
   * An explicit minimum duration (the Min duration picker): calls shorter than this are folded,
   * whatever their share. Without it the rule is measurement precision and a tiny share.
   */
  minUs?: number;
  /** Label of the threshold, e.g. "3.2 ms". */
  threshold: string;
  /** Rows that must stay visible on their own (the selection). */
  keep: ReadonlySet<number>;
}

export interface Folded {
  rows: WaterfallRow[];
  /** Ids of the fold rows, to start collapsed. */
  folds: number[];
  /** Rows hidden behind small-row folds. */
  hiddenSmall: number;
}

const isNoise = (r: WaterfallRow, minUs?: number): boolean =>
  r.kind === 'call' &&
  !r.critical &&
  (minUs !== undefined ? r.end - r.start < minUs : r.belowPrecision && r.share < NOISE_SHARE);

const isRuntime = (r: WaterfallRow): boolean =>
  r.kind === 'call' && !r.critical && (r.origin === Origin.Node || r.origin === Origin.Native);

function foldRow(
  id: number,
  fold: 'small' | 'bootstrap',
  label: string,
  members: readonly WaterfallRow[],
  count: number,
  base: WaterfallRow,
): WaterfallRow {
  const start = Math.min(...members.map((m) => m.start));
  const end = Math.max(...members.map((m) => m.end));
  return {
    id,
    kind: 'fold',
    fold,
    foldedCount: count,
    fn: -1,
    path: [],
    name: label,
    loc: '',
    origin: Origin.Idle,
    start,
    end: fold === 'bootstrap' ? end : start,
    depth: base.depth,
    parent: base.parent,
    hasChildren: true,
    critical: false,
    belowPrecision: fold === 'small',
    share: members.reduce((s, m) => s + m.share, 0),
    resumed: false,
    summaryTasks: [],
    selfUs: 0,
  };
}

/**
 * Fold the engine's rows. `rows` must be in preorder with `parent` ids that are row ids (the
 * engine's whole-run rows, or the task rows with the task row first).
 */
export function foldRows(rows: readonly WaterfallRow[], o: FoldOptions): Folded {
  if (!o.hideSmall && !o.bootstrap) return { rows: rows.slice(), folds: [], hiddenSmall: 0 };
  const kids = new Map<number, WaterfallRow[]>();
  for (const r of rows) {
    const list = kids.get(r.parent) ?? [];
    list.push(r);
    kids.set(r.parent, list);
  }
  const subtreeSize = (r: WaterfallRow): number => {
    let n = 1;
    for (const k of kids.get(r.id) ?? []) n += subtreeSize(k);
    return n;
  };
  const roots = kids.get(-1) ?? [];
  // The run is rooted at one row; its children are the top level (the task row in a task view).
  const top = roots.length === 1 ? (roots[0] as WaterfallRow) : null;

  const out: WaterfallRow[] = [];
  const folds: number[] = [];
  let hiddenSmall = 0;
  // -1 is the parent id of the roots, so folds are numbered from -2.
  let nextFold = -2;

  const emit = (r: WaterfallRow, shift: number, parent: number): void => {
    out.push({ ...r, depth: r.depth + shift, parent });
    emitChildren(r, shift, r.id, r.id === top?.id);
  };

  const emitChildren = (
    parent: WaterfallRow,
    shift: number,
    parentId: number,
    isTop: boolean,
  ): void => {
    const list = kids.get(parent.id) ?? [];
    let i = 0;
    // Node's bootstrap: the leading run of runtime rows directly under the root.
    if (o.bootstrap && isTop) {
      let j = 0;
      while (
        j < list.length &&
        isRuntime(list[j] as WaterfallRow) &&
        !o.keep.has((list[j] as WaterfallRow).id)
      )
        j++;
      if (j > 0) {
        const members = list.slice(0, j);
        const count = members.reduce((n, m) => n + subtreeSize(m), 0);
        const id = nextFold--;
        folds.push(id);
        out.push(
          foldRow(id, 'bootstrap', 'node bootstrap', members, count, {
            ...(members[0] as WaterfallRow),
            depth: (members[0] as WaterfallRow).depth + shift,
            parent: parentId,
          }),
        );
        for (const m of members) emit(m, shift + 1, id);
        i = j;
      }
    }
    // Noise rows of one parent share a single fold, placed where the first of them ran.
    const noise = o.hideSmall
      ? list.slice(i).filter((r) => isNoise(r, o.minUs) && !o.keep.has(r.id))
      : [];
    let foldId = 0;
    while (i < list.length) {
      const r = list[i] as WaterfallRow;
      if (noise.includes(r)) {
        if (foldId === 0) {
          const count = noise.reduce((n, m) => n + subtreeSize(m), 0);
          foldId = nextFold--;
          folds.push(foldId);
          hiddenSmall += count;
          out.push(
            foldRow(
              foldId,
              'small',
              `${count} ${count === 1 ? 'row' : 'rows'} under ${o.threshold} hidden`,
              noise,
              count,
              { ...r, depth: r.depth + shift, parent: parentId },
            ),
          );
          for (const m of noise) emit(m, shift + 1, foldId);
        }
        i++;
        continue;
      }
      emit(r, shift, parentId);
      i++;
    }
  };

  for (const r of roots) emit(r, 0, -1);
  return { rows: out, folds, hiddenSmall };
}

/** Module loading frames (`require ▸ path`) are not the work the user is looking for. */
const isLoader = (r: WaterfallRow): boolean => r.name.startsWith('require ▸');

/** The most of a parent's work a child must carry for the chain to keep going into it. */
const FOLLOW_SHARE = 0.5;

/**
 * The chain to open first, ending in the target's own work. A row's work is its CPU time minus the
 * CPU time spent loading modules under it; the chain starts at the row of your code with the most work
 * (the entry root aside) and follows the heaviest child of your code while that child carries at
 * least half of it. Self time is not the guide: it is spread thin across a stitched run, and the
 * hottest single line is rarely where the work starts. `null` when there is no code of the
 * target to point at.
 */
export function hotTargetPath(rows: readonly WaterfallRow[]): number[] | null {
  const kids = new Map<number, WaterfallRow[]>();
  for (const r of rows) {
    const list = kids.get(r.parent) ?? [];
    list.push(r);
    kids.set(r.parent, list);
  }
  // CPU time of a row: its own time and everything under it. A row's extent on the clock also
  // holds the awaiting between its segments, which is not work.
  const cpu = new Map<number, number>();
  const cpuOf = (r: WaterfallRow): number => {
    const known = cpu.get(r.id);
    if (known !== undefined) return known;
    let t = r.selfUs;
    for (const c of kids.get(r.id) ?? []) t += cpuOf(c);
    cpu.set(r.id, t);
    return t;
  };
  const loading = new Map<number, number>();
  const loadingUnder = (r: WaterfallRow): number => {
    const known = loading.get(r.id);
    if (known !== undefined) return known;
    let t = 0;
    for (const c of kids.get(r.id) ?? []) t += isLoader(c) ? cpuOf(c) : loadingUnder(c);
    loading.set(r.id, t);
    return t;
  };
  const work = (r: WaterfallRow): number => cpuOf(r) - loadingUnder(r);
  const own = (r: WaterfallRow): boolean =>
    r.kind === 'call' && r.origin === Origin.User && !isLoader(r);

  let best: WaterfallRow | null = null;
  for (const r of rows) {
    if (r.depth < 1 || !own(r)) continue;
    if (!best || work(r) > work(best)) best = r;
  }
  if (!best || work(best) <= 0) return null;
  const chain: WaterfallRow[] = [best];
  for (;;) {
    const here = chain[chain.length - 1] as WaterfallRow;
    let next: WaterfallRow | null = null;
    for (const c of kids.get(here.id) ?? [])
      if (own(c) && (!next || work(c) > work(next))) next = c;
    if (!next || work(next) < FOLLOW_SHARE * work(here)) break;
    chain.push(next);
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const path: number[] = [];
  for (let r: WaterfallRow | undefined = chain[chain.length - 1]; r; r = byId.get(r.parent))
    path.push(r.id);
  return path.reverse();
}

/**
 * Rows to collapse on first sight: everything with children except the heaviest chain, followed
 * down at most `INITIAL_DEPTH` levels and while a row still carries `MIN_PATH_SHARE` of the run.
 * Siblings of the chain stay visible but closed.
 */
export function initialCollapsed(
  rows: readonly WaterfallRow[],
  criticalRows: readonly number[],
  folds: readonly number[],
  evidence: ReadonlySet<number> = new Set(),
): Set<number> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const open = new Set<number>();
  // Prefer the chain to the target's hottest function; the widest chain is the fallback.
  const hot = hotTargetPath(rows);
  if (hot) {
    for (const id of hot) {
      const r = byId.get(id);
      if (!r || r.depth > INITIAL_DEPTH) break;
      open.add(id);
    }
  } else {
    for (const id of criticalRows) {
      const r = byId.get(id);
      if (!r || r.depth > INITIAL_DEPTH || (open.size > 0 && r.share < MIN_PATH_SHARE)) break;
      open.add(id);
    }
  }
  // Findings must not hide inside a closed row: open the way to the longest row of each function
  // a finding names as its evidence (the sync read under a request, say).
  const longest = new Map<number, WaterfallRow>();
  for (const r of rows) {
    if (r.kind !== 'call' || !evidence.has(r.fn)) continue;
    const held = longest.get(r.fn);
    if (!held || r.end - r.start > held.end - held.start) longest.set(r.fn, r);
  }
  for (const r of longest.values()) {
    for (let p = byId.get(r.parent); p; p = byId.get(p.parent)) open.add(p.id);
  }
  const closed = new Set<number>(folds);
  for (const r of rows) if (r.hasChildren && !open.has(r.id)) closed.add(r.id);
  return closed;
}

/**
 * The collapsed set after the rows or the selection changed: a fresh result opens along the chain to
 * the target's hottest function and closes the rest; a selected row keeps its ancestors open. Null when
 * the set stays as it is.
 */
export function reconcileCollapsed(i: {
  rows: readonly WaterfallRow[];
  folded: Folded | null;
  /** The folded result is new since the last reconcile. */
  fresh: boolean;
  criticalRows: readonly number[];
  evidence: ReadonlySet<number>;
  selectedRowId: number | null;
  collapsed: ReadonlySet<number>;
}): ReadonlySet<number> | null {
  const base: ReadonlySet<number> =
    i.fresh && i.folded
      ? initialCollapsed(i.folded.rows, i.criticalRows, i.folded.folds, i.evidence)
      : i.collapsed;
  const byId = new Map(i.rows.map((r) => [r.id, r]));
  const open = new Set<number>();
  if (i.selectedRowId !== null) {
    for (let p = byId.get(i.selectedRowId)?.parent ?? -1; p !== -1; p = byId.get(p)?.parent ?? -1) {
      open.add(p);
    }
  }
  const next = new Set([...base].filter((id) => !open.has(id)));
  return i.fresh || next.size !== i.collapsed.size ? next : null;
}
