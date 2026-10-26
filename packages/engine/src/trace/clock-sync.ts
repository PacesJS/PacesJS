import type { RecordedSegment, TraceEventIn } from './types.js';

export interface ClockAnchor {
  /** `epoch µs = trace µs + offsetUs`. */
  offsetUs: number;
  errorUs: number;
  anchored: boolean;
}

/** Without a stamp from the page the host's own clock is all there is; its latency is milliseconds. */
const HOST_CLOCK_ERROR_US = 20_000;
/** What the stamp itself is good for, measured against the page clock. */
const STAMP_ERROR_FLOOR_US = 50;

const SYNC = /^paces:sync:(\d+)$/;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** `ts` of each `console.timeStamp('paces:sync:<n>')` in the trace, by n. */
function syncStamps(events: TraceEventIn[]): Map<number, number> {
  const stamps = new Map<number, number>();
  for (const e of events) {
    if (e.name !== 'TimeStamp') continue;
    const message = (e.args as { data?: { message?: unknown } } | undefined)?.data?.message;
    const match = typeof message === 'string' ? SYNC.exec(message) : null;
    if (match && !stamps.has(Number(match[1]))) stamps.set(Number(match[1]), e.ts);
  }
  return stamps;
}

/**
 * Ties the trace's monotonic clock to wall-clock time. Each segment carries the epoch time the page
 * reported at a stamp that is also in the trace; the median of those offsets is the anchor and their
 * spread its error. A segment with no stamp falls back to when the host started tracing.
 */
export function anchorClock(
  events: TraceEventIn[],
  segments: RecordedSegment[],
  unanchored: { startedAt: number; firstTs: number } | undefined,
): ClockAnchor {
  if (unanchored) {
    return {
      offsetUs: unanchored.startedAt * 1000 - unanchored.firstTs,
      errorUs: 0,
      anchored: false,
    };
  }
  const stamps = syncStamps(events);
  const exact: number[] = [];
  for (const segment of segments) {
    for (const sync of segment.syncs) {
      const ts = stamps.get(sync.n);
      if (ts !== undefined) exact.push(sync.epochMs * 1000 - ts);
    }
  }
  if (exact.length > 0) {
    const offsetUs = median(exact);
    const spread = Math.max(...exact.map((o) => Math.abs(o - offsetUs)));
    return { offsetUs, errorUs: Math.max(STAMP_ERROR_FLOOR_US, spread), anchored: true };
  }
  const guesses = segments
    .filter((s) => Number.isFinite(s.startUs))
    .map((s) => s.hostStartMs * 1000 - s.startUs);
  const offsetUs = guesses.length > 0 ? median(guesses) : 0;
  return { offsetUs, errorUs: HOST_CLOCK_ERROR_US, anchored: guesses.length > 0 };
}
