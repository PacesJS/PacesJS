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
export const MIN_PATH_SHARE = 0.05;

export interface FoldOptions {
  /** Hide rows below precision and `NOISE_SHARE` behind one summary row per run of siblings. */
  hideSmall: boolean;
  /** Fold the leading Node and native frames before the first user frame into "node bootstrap". */
  bootstrap: boolean;
  /** Label of the precision threshold, e.g. "3.2 ms". */
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

const isNoise = (r: WaterfallRow): boolean =>
  r.kind === 'call' && r.belowPrecision && r.share < NOISE_SHARE && !r.critical;

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
    const noise = o.hideSmall ? list.slice(i).filter((r) => isNoise(r) && !o.keep.has(r.id)) : [];
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

/**
 * The chain to open first: the ancestors of the target's hottest own function (most self time in
 * your code, loaders and the entry root aside). In a stitched run no single chain from the root is
 * heavy, so the widest-child chain would end up inside a dependency; this one ends in real work.
 * `null` when the run has no code of the target to point at.
 */
export function hotTargetPath(rows: readonly WaterfallRow[]): number[] | null {
  let best: WaterfallRow | null = null;
  for (const r of rows) {
    if (r.kind !== 'call' || r.depth < 1 || r.origin !== Origin.User || isLoader(r)) continue;
    if (!best || r.selfUs > best.selfUs) best = r;
  }
  if (!best || best.selfUs <= 0) return null;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const path: number[] = [];
  for (let r: WaterfallRow | undefined = best; r; r = byId.get(r.parent)) path.push(r.id);
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
  const closed = new Set<number>(folds);
  for (const r of rows) if (r.hasChildren && !open.has(r.id)) closed.add(r.id);
  return closed;
}
