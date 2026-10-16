import type { WaterfallRow } from '../data/types';

/**
 * Row indexes to draw. Rows under a collapsed ancestor are hidden; in critical-path-only mode
 * everything outside the critical chain is hidden (the chain itself stays expandable by `p`).
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
    if (collapsed.has(i)) hideBelow = r.depth;
  });
  return out;
}
