const MIN_BAR = 4;
const MIN_SELF = 3;

/**
 * Width of the part of a bar that stands for the call's own time, anchored to its left edge. Own time
 * is spread between the callees, so this is a share, not a position. Bars too narrow to show a stripe
 * get none.
 */
export function selfWidth(barWidth: number, selfUs: number, totalUs: number): number {
  if (barWidth < MIN_BAR || selfUs <= 0 || totalUs <= 0) return 0;
  const w = Math.round(barWidth * Math.min(1, selfUs / totalUs));
  return Math.min(barWidth, Math.max(MIN_SELF, w));
}
