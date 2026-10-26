import type { SourceInfo } from '../data/types';

const TEXT = {
  note: (count: number) =>
    `V8 threw away optimized code ${count} ${count === 1 ? 'time' : 'times'}`,
  here: (count: number, reasons: string) =>
    `V8 threw away optimized code here ${count} ${count === 1 ? 'time' : 'times'}: ${reasons}`,
  lazy: (count: number, reasons: string) =>
    `V8 threw away optimized code ${count} ${count === 1 ? 'time' : 'times'} after something it depended on changed (${reasons}); the code resumed on this line`,
  reason: (reason: string, count: number) => (count > 1 ? `${reason} ×${count}` : reason),
  separator: ', ',
} as const;

/** One sentence for a bar: how often V8 deoptimized the function. */
export const deoptNote = (count: number): string => TEXT.note(count);

/**
 * What to say on a source line. A lazy deopt is reported where the code resumed, not where something
 * broke, so it is worded as that and never as an assumption failing on this line.
 */
export function deoptSourceTitle(sites: SourceInfo['deopts']): string {
  const count = sites.reduce((n, s) => n + s.count, 0);
  const reasons = sites
    .slice()
    .sort((a, b) => b.count - a.count)
    .map((s) => TEXT.reason(s.reason, s.count))
    .join(TEXT.separator);
  return sites.every((s) => s.kind === 'lazy')
    ? TEXT.lazy(count, reasons)
    : TEXT.here(count, reasons);
}
