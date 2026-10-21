import type { CSSProperties } from 'react';
import type { WaterfallRow } from '../data/types';
import { fmtDuration, fmtShare } from '../util/format';

const TEXT = {
  below: (threshold: string) => `< ${threshold}`,
  idle: (duration: string) => `idle ${duration}`,
  span: (start: string, end: string) => `${start}–${end} ms`,
  belowPrecision: (threshold: string) => `< ${threshold}, below sampling precision`,
  elapsed: (elapsed: string, cpu: string, waiting: string) =>
    `elapsed ${elapsed} (CPU ${cpu}, ${waiting} awaiting)`,
  details: (lead: string, share: string, whole: string, span: string) =>
    `${lead} · ${share} of the ${whole} · ${span}`,
  eventLoopTask: 'event-loop task',
  resumedTip:
    'Continuations after an await are attached to the call that started them (inferred; run with --async for exact).',
} as const;

/** The "< X" label of a row below measurement precision; set once the summary is known. */
export function durLabel(r: WaterfallRow, threshold = '2 ms'): string {
  if (r.kind === 'fold' && r.fold === 'small') return '';
  if (r.belowPrecision) return TEXT.below(threshold);
  return fmtDuration(r.end - r.start, { decimals: 1 });
}

/** Waiting shorter than this is not worth a row of its own wording. */
const MIN_AWAIT_US = 1000;
/** A call spends this share of its extent not running before it counts as awaiting. */
const AWAIT_SHARE = 0.1;

/** CPU time of a row against its elapsed extent, for calls that await (or resume after one). */
interface Elapsed {
  cpuUs: number;
}

/**
 * What a bar says when you point at it: how long, how much of the whole, and when. A call that
 * awaits spans wall-clock time, so it says how much of that was CPU and how much was waiting.
 */
export function barDetails(
  r: WaterfallRow,
  threshold: string,
  whole: string,
  elapsed?: Elapsed,
): string {
  if (r.kind === 'wait') return TEXT.idle(fmtDuration(r.end - r.start, { decimals: 1 }));
  if (r.kind === 'fold' && r.fold === 'small') return '';
  const span = TEXT.span((r.start / 1000).toFixed(1), (r.end / 1000).toFixed(1));
  const dur = r.end - r.start;
  let lead: string;
  if (r.belowPrecision) lead = TEXT.belowPrecision(threshold);
  else if (
    elapsed &&
    r.kind === 'call' &&
    dur - elapsed.cpuUs >= Math.max(MIN_AWAIT_US, AWAIT_SHARE * dur)
  ) {
    const waiting = Math.max(0, dur - elapsed.cpuUs);
    lead = TEXT.elapsed(
      fmtDuration(dur, { approx: false, decimals: 1 }),
      fmtDuration(elapsed.cpuUs, { decimals: 1 }),
      fmtDuration(waiting, { decimals: 0 }),
    );
  } else lead = durLabel(r, threshold);
  return TEXT.details(lead, fmtShare(r.share), whole, span);
}

const ORIGIN_HINT: Record<number, string> = { 1: 'node_modules', 3: 'node', 4: 'native', 6: 'V8' };

export function rowLocation(r: WaterfallRow): string {
  if (r.kind === 'task') return TEXT.eventLoopTask;
  if (r.kind === 'wait' || r.kind === 'summary') return '';
  return r.loc || (ORIGIN_HINT[r.origin] ?? '');
}

export function samePath(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((f, i) => f === b[i]);
}

/** Below the bar, or above it near the bottom, and always inside the viewport. */
export function tipStyle(
  tip: { text: string; x: number; y: number; top: number },
  vw: number,
  vh: number,
): CSSProperties {
  const width = Math.min(vw - 16, tip.text.length * 7.5 + 28);
  const left = Math.max(8, Math.min(tip.x - width / 2, vw - width - 8));
  const below = tip.y + 6 + 44 <= vh;
  return {
    position: 'fixed',
    left,
    top: below ? tip.y + 6 : Math.max(8, tip.top - 6 - 44),
    maxWidth: vw - 16,
    zIndex: 40,
  };
}

export const RESUMED_TIP = TEXT.resumedTip;
