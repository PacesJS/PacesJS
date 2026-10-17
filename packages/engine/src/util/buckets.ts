// Fixed-width time buckets: how much of each bucket an interval covers.

/** Adds, for every bucket the interval [a, b) touches, the covered fraction of that bucket (0..1). */
export function addCoverage(
  acc: Float32Array,
  a: number,
  b: number,
  start: number,
  width: number,
): void {
  for (let k = Math.max(0, Math.floor((a - start) / width)); k < acc.length; k++) {
    const lo = start + k * width;
    if (lo >= b) break;
    const overlap = Math.min(b, lo + width) - Math.max(a, lo);
    if (overlap > 0) acc[k] = (acc[k] ?? 0) + overlap / width;
  }
}

/** Caps every bucket at 1: overlapping intervals can add up past a full bucket. */
export function capAtOne(acc: Float32Array): void {
  for (let k = 0; k < acc.length; k++) acc[k] = Math.min(1, acc[k] ?? 0);
}
