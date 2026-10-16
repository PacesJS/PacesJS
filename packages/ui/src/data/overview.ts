import type { ExecutionModel, Track } from '@pacesjs/engine';
import { ORIGIN_IDLE, at } from './access';
import { taskLabel } from './waterfall';

export const LONG_TASK_US = 50_000;

export interface LaneData {
  id: string;
  label: string;
  meta: string;
  durationUs: number;
  /** CPU busy fraction per bin, 0..1. */
  cpu: Float32Array;
  taskStart: Float64Array;
  taskEnd: Float64Array;
  /** Dominant origin index per task (0 = your code). */
  taskOrigin: Uint8Array;
  taskLabels: string[];
  gcTime: Float64Array;
  gcDuration: Float64Array;
  /** Event-loop delay p99 per bin, microseconds. */
  delay: Float32Array;
  peakDelayUs: number;
  peakDelayAtUs: number;
  hasLoopData: boolean;
}

export interface OverviewData {
  durationUs: number;
  bins: number;
  lanes: LaneData[];
}

/** Track labels look like "main · pid 4182": the part before the dot is the lane title. */
function laneText(model: ExecutionModel, track: Track): { title: string; meta: string } {
  const [title = track.label, ...rest] = track.label.split(' · ');
  const detail = rest.join(' · ');
  if (track.kind === 'process') {
    const script = model.meta.command[1] ?? model.meta.command[0] ?? '';
    const base = script.split(/[/\\]/).pop() ?? script;
    return { title, meta: [detail, base].filter(Boolean).join(' · ') || 'node process' };
  }
  return { title, meta: detail || (track.kind === 'worker' ? 'worker thread' : track.kind) };
}

function dominantOrigins(model: ExecutionModel, track: Track): Uint8Array {
  const tasks = track.tasks;
  const out = new Uint8Array(tasks.length);
  const s = track.samples;
  let si = 0;
  for (let ti = 0; ti < tasks.length; ti++) {
    const start = at(tasks.start, ti);
    const end = at(tasks.end, ti);
    while (si < s.length && at(s.time, si) < start) si++;
    const w = new Float64Array(7);
    let j = si;
    while (j < s.length && at(s.time, j) < end) {
      const fn = at(track.callTree.fn, at(s.node, j));
      const o = at(model.functions.origin, fn);
      w[o] = (w[o] ?? 0) + 1;
      j++;
    }
    let best = 0;
    let busy = 0;
    for (let o = 0; o < 7; o++) if (o !== ORIGIN_IDLE) busy += w[o] ?? 0;
    if ((w[0] ?? 0) < busy * 0.2) {
      let bw = -1;
      for (let o = 1; o < 7; o++) {
        if (o !== ORIGIN_IDLE && (w[o] ?? 0) > bw) {
          bw = w[o] ?? 0;
          best = o;
        }
      }
    }
    out[ti] = best;
  }
  return out;
}

export function buildOverview(model: ExecutionModel, bins = 240): OverviewData {
  const durationUs = Math.max(model.meta.durationUs, ...model.tracks.map((t) => t.durationUs), 1);
  const binW = durationUs / bins;
  const lanes = model.tracks.map((track): LaneData => {
    const cpu = new Float32Array(bins);
    const s = track.samples;
    const interval = model.meta.intervalUs;
    for (let i = 0; i < s.length; i++) {
      const fn = at(track.callTree.fn, at(s.node, i));
      if (at(model.functions.origin, fn) === ORIGIN_IDLE) continue;
      const t = at(s.time, i);
      const next = i + 1 < s.length ? at(s.time, i + 1) : t + interval;
      const b = Math.min(bins - 1, Math.floor(t / binW));
      cpu[b] = (cpu[b] ?? 0) + (next - t) / binW;
    }
    for (let b = 0; b < bins; b++) cpu[b] = Math.min(1, cpu[b] ?? 0);

    const delay = new Float32Array(bins);
    let peak = 0;
    let peakAt = 0;
    const loop = track.events.loop;
    for (let i = 0; i < loop.time.length; i++) {
      const b = Math.min(bins - 1, Math.max(0, Math.floor(at(loop.time, i) / binW)));
      const v = at(loop.p99, i);
      delay[b] = Math.max(delay[b] ?? 0, v);
      if (v > peak) {
        peak = v;
        peakAt = at(loop.time, i);
      }
    }
    const labels: string[] = [];
    for (let i = 0; i < track.tasks.length; i++) labels.push(taskLabel(model, track, i));
    return {
      id: track.id,
      label: laneText(model, track).title,
      meta: laneText(model, track).meta,
      durationUs,
      cpu,
      taskStart: track.tasks.start,
      taskEnd: track.tasks.end,
      taskOrigin: dominantOrigins(model, track),
      taskLabels: labels,
      gcTime: track.events.gc.time,
      gcDuration: track.events.gc.duration,
      delay,
      peakDelayUs: peak,
      peakDelayAtUs: peakAt,
      hasLoopData: loop.time.length > 0,
    };
  });
  return { durationUs, bins, lanes };
}
