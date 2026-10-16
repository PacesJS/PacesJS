// CPU profiles are stamped with a monotonic clock; runtime events and `meta.startedAt` use epoch
// time. Nothing in a capture links the two, so the offset is estimated here, once per capture:
// monotonic clocks are system-wide, so every process and worker shares it.

import type { RawCapture, RawTrack } from '../raw.js';

export interface ClockAlignment {
  /** Monotonic microsecond reading that corresponds to `meta.startedAt`. */
  monoAtStartUs: number;
  /** The feasible range the estimate was searched in. */
  lowUs: number;
  highUs: number;
  /** Samples of `(garbage collector)` that fall inside GC event intervals at the chosen offset. */
  gcHits: number;
}

interface TrackSignal {
  /** Monotonic times of GC samples, ascending. */
  gcSampleMono: Float64Array;
  /** GC events as [model time of start, model time of end] in microseconds. */
  gcWindows: Array<[number, number]>;
  requestWindows: Array<[number, number]>;
  /** Monotonic sample times and prefix sums of busy (non-idle) duration. */
  sampleMono: Float64Array;
  busyPrefix: Float64Array;
}

function lowerBound(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((a[mid] ?? 0) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function signalOf(track: RawTrack, startedAt: number): TrackSignal | undefined {
  const profile = track.cpuProfile;
  if (!profile) return undefined;
  const kind = new Map<number, number>();
  for (const n of profile.nodes) {
    const name = n.callFrame.functionName;
    kind.set(n.id, name === '(garbage collector)' ? 1 : name === '(idle)' ? 2 : 0);
  }
  const count = profile.samples.length;
  const sampleMono = new Float64Array(count);
  const busyPrefix = new Float64Array(count + 1);
  const gc: number[] = [];
  let t = profile.startTime;
  for (let i = 0; i < count; i++) {
    t += profile.timeDeltas[i] ?? 0;
    sampleMono[i] = t;
    const k = kind.get(profile.samples[i] ?? -1) ?? 0;
    if (k === 1) gc.push(t);
    const dur = (profile.timeDeltas[i + 1] ?? 1000) > 0 ? (profile.timeDeltas[i + 1] ?? 1000) : 0;
    busyPrefix[i + 1] = (busyPrefix[i] ?? 0) + (k === 2 ? 0 : dur);
  }
  const gcWindows: Array<[number, number]> = [];
  const requestWindows: Array<[number, number]> = [];
  for (const e of track.events) {
    const start = (e.time - startedAt) * 1000;
    if (e.type === 'gc') gcWindows.push([start, start + e.duration * 1000]);
    else if (e.type === 'request') requestWindows.push([start, start + e.duration * 1000]);
  }
  return { gcSampleMono: Float64Array.from(gc), gcWindows, requestWindows, sampleMono, busyPrefix };
}

function busyBetween(s: TrackSignal, a: number, b: number): number {
  const i = lowerBound(s.sampleMono, a);
  const j = lowerBound(s.sampleMono, b);
  return (s.busyPrefix[j] ?? 0) - (s.busyPrefix[i] ?? 0);
}

export function alignClock(capture: RawCapture): ClockAlignment {
  const { startedAt, endedAt } = capture.meta;
  const wallUs = Math.max(0, (endedAt - startedAt) * 1000);
  const profiled = capture.tracks.filter((t) => t.cpuProfile && t.cpuProfile.samples.length > 0);
  if (profiled.length === 0) return { monoAtStartUs: 0, lowUs: 0, highUs: 0, gcHits: 0 };

  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const t of profiled) {
    const p = t.cpuProfile;
    if (!p) continue;
    minStart = Math.min(minStart, p.startTime);
    maxEnd = Math.max(maxEnd, p.endTime);
  }
  // The profile has to fit inside [startedAt, endedAt]. Anchor on its end; refine below.
  let low = maxEnd - wallUs;
  let high = minStart;
  if (low > high) {
    const mid = (low + high) / 2;
    low = mid - 20_000;
    high = mid + 20_000;
  }
  const anchor = low;

  const signals = profiled.flatMap((t) => signalOf(t, startedAt) ?? []);
  const interval = Math.max(1000, capture.meta.intervalUs);
  const hasSignal = signals.some((s) => s.gcWindows.length > 0 || s.requestWindows.length > 0);
  if (!hasSignal) return { monoAtStartUs: anchor, lowUs: low, highUs: high, gcHits: 0 };

  const step = Math.max(200, (high - low) / 6000);
  const pad = interval * 1.5;
  const candidates: Array<{ c: number; gc: number; req: number }> = [];
  let maxGc = 0;
  for (let c = low; c <= high + 1e-6; c += step) {
    let gc = 0;
    let req = 0;
    for (const s of signals) {
      for (const [a, b] of s.gcWindows) {
        const i = lowerBound(s.gcSampleMono, a + c - pad);
        const j = lowerBound(s.gcSampleMono, b + c + pad);
        gc += j - i;
      }
      for (const [a, b] of s.requestWindows) {
        if (b > a) req += busyBetween(s, a + c, b + c) / (b - a);
      }
    }
    maxGc = Math.max(maxGc, gc);
    candidates.push({ c, gc, req });
  }
  // Best GC agreement first, then request-window busyness; the middle of the plateau is the
  // estimate because every offset on it explains the data equally well.
  const atMaxGc = candidates.filter((x) => x.gc === maxGc);
  const maxReq = Math.max(...atMaxGc.map((x) => x.req));
  const top = atMaxGc.filter((x) => x.req >= maxReq - 0.02);
  const best = top[Math.floor(top.length / 2)]?.c ?? anchor;
  return { monoAtStartUs: best, lowUs: low, highUs: high, gcHits: maxGc };
}
