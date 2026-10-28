// What the main thread was doing at every moment of a range: running a task, idle with a request in
// flight, or idle with none. Shared by the slow-load finding and the lane that shows the same split.

import type { ExecutionModel } from '../model.js';

/** `paused`: recording was off, so nothing is known about the main thread. */
export type StretchCause = 'paused' | 'busy' | 'requests' | 'nothing';

export interface Stretch {
  start: number;
  end: number;
  cause: StretchCause;
}

/** Contiguous stretches covering `[from, to]`, neighbours with the same cause joined. */
export function stretches(model: ExecutionModel, from: number, to: number): Stretch[] {
  const edges: Array<{ at: number; busy: number; flight: number; off: number }> = [];
  const track = model.tracks[model.primaryTrack];
  for (let k = 0; track && k < track.tasks.length; k++) {
    const a = Math.max(from, track.tasks.start[k] ?? 0);
    const b = Math.min(to, track.tasks.end[k] ?? 0);
    if (b > a)
      edges.push({ at: a, busy: 1, flight: 0, off: 0 }, { at: b, busy: -1, flight: 0, off: 0 });
  }
  const t = model.page?.requests;
  for (let i = 0; t && i < t.length; i++) {
    const end = t.end[i] ?? -1;
    const a = Math.max(from, t.start[i] ?? 0);
    const b = Math.min(to, end);
    if (end >= 0 && b > a) {
      edges.push({ at: a, busy: 0, flight: 1, off: 0 }, { at: b, busy: 0, flight: -1, off: 0 });
    }
  }
  const off = model.page?.paused;
  for (let i = 0; off && i < off.length; i++) {
    const a = Math.max(from, off.start[i] ?? 0);
    const b = Math.min(to, off.end[i] ?? 0);
    if (b > a)
      edges.push({ at: a, busy: 0, flight: 0, off: 1 }, { at: b, busy: 0, flight: 0, off: -1 });
  }
  edges.sort((x, y) => x.at - y.at);

  const out: Stretch[] = [];
  const add = (start: number, end: number, busy: number, flight: number, off: number): void => {
    if (end <= start) return;
    const cause: StretchCause =
      off > 0 ? 'paused' : busy > 0 ? 'busy' : flight > 0 ? 'requests' : 'nothing';
    const last = out[out.length - 1];
    if (last && last.cause === cause) last.end = end;
    else out.push({ start, end, cause });
  };
  let busy = 0;
  let flight = 0;
  let paused = 0;
  let cursor = from;
  for (const e of edges) {
    add(cursor, e.at, busy, flight, paused);
    cursor = Math.max(cursor, e.at);
    busy += e.busy;
    flight += e.flight;
    paused += e.off;
  }
  add(cursor, to, busy, flight, paused);
  return out;
}
