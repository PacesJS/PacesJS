// Binary searches over sorted typed arrays.

import type { TaskTable } from '../model.js';

/** First index whose value is not below `x` (`a.length` when every value is). */
export function lowerBound(a: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((a[mid] ?? 0) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Task whose span range contains `span`, or -1. */
export function taskOfSpan(
  tasks: Pick<TaskTable, 'length' | 'spanStart' | 'spanEnd'>,
  span: number,
): number {
  let lo = 0;
  let hi = tasks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((tasks.spanStart[mid] ?? 0) <= span) lo = mid + 1;
    else hi = mid;
  }
  const k = lo - 1;
  return k >= 0 && span < (tasks.spanEnd[k] ?? 0) ? k : -1;
}
