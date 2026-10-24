import type { RunMark } from '../data/marks';

export type MarkSpan = { kind: 'before' } | { kind: 'after' } | { kind: 'between'; other: number };

/**
 * The time range a mark asks to focus on: everything before it, everything after it, or the stretch
 * between it and another mark. Null when that stretch is empty.
 */
export function markRange(
  marks: readonly RunMark[],
  index: number,
  span: MarkSpan,
  durationUs: number,
): [number, number] | null {
  const here = marks[index];
  if (!here) return null;
  let range: [number, number];
  if (span.kind === 'before') range = [0, here.us];
  else if (span.kind === 'after') range = [here.us, durationUs];
  else {
    const there = marks[span.other];
    if (!there) return null;
    range = [Math.min(here.us, there.us), Math.max(here.us, there.us)];
  }
  return range[1] > range[0] ? range : null;
}
