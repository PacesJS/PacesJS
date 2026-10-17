/** Level of detail: merge blocks that fall inside the same pixel so huge captures stay cheap. */

export interface PackedBlock {
  /** Left edge in px. */
  x: number;
  /** Width in px, at least `minWidth`. */
  w: number;
  /** How many source blocks are merged here (1 = a real block). */
  count: number;
  /** Index of the first source block, for hit testing a single block. */
  first: number;
}

/**
 * `starts`/`ends` must be sorted by start. Blocks closer than `mergeGap` px merge into one
 * aggregate block; wide blocks stay as they are.
 */
export function packBlocks(
  starts: ArrayLike<number>,
  ends: ArrayLike<number>,
  toPx: (v: number) => number,
  minWidth = 1,
  mergeGap = 0.75,
): PackedBlock[] {
  const out: PackedBlock[] = [];
  let cur: PackedBlock | null = null;
  for (let i = 0; i < starts.length; i++) {
    const x0 = toPx(starts[i] ?? 0);
    const x1 = toPx(ends[i] ?? 0);
    const w = Math.max(x1 - x0, minWidth);
    if (cur && x0 - (cur.x + cur.w) < mergeGap && (w < 2 || cur.w < 2)) {
      cur.w = Math.max(cur.w, x0 + w - cur.x);
      cur.count += 1;
    } else {
      cur = { x: x0, w, count: 1, first: i };
      out.push(cur);
    }
  }
  return out;
}

/** Index range [lo, hi) of sorted values within [a, b]; binary search. */
export function visibleRange(sorted: ArrayLike<number>, a: number, b: number): [number, number] {
  return [lowerBound(sorted, a), upperBound(sorted, b)];
}

/** First index whose value is greater than `v`. */
function upperBound(sorted: ArrayLike<number>, v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] ?? 0) <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function lowerBound(sorted: ArrayLike<number>, v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] ?? 0) < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Hatch below two sampling intervals (honest-data rule). */
export function isBelowPrecision(durationUs: number, intervalUs: number): boolean {
  return durationUs < 2 * intervalUs;
}
