import type { WaterfallRow } from '../data/types';

/** Sibling order; the engine sorts (`waterfallForTask` option `sort`). */
export type WaterfallSort = 'time' | 'duration' | 'share';

/**
 * Row indexes to draw. Rows under a collapsed ancestor (ids in `collapsed`) are hidden; in
 * critical-path-only mode everything outside the critical chain is hidden.
 */
export function visibleRows(
  rows: readonly WaterfallRow[],
  collapsed: ReadonlySet<number>,
  criticalOnly: readonly number[] | null = null,
): number[] {
  if (criticalOnly) {
    const keep = new Set(criticalOnly);
    return rows.flatMap((r, i) => (keep.has(r.id) ? [i] : []));
  }
  const out: number[] = [];
  let hideBelow = Infinity;
  rows.forEach((r, i) => {
    if (r.depth > hideBelow) return;
    hideBelow = Infinity;
    out.push(i);
    if (collapsed.has(r.id)) hideBelow = r.depth;
  });
  return out;
}
