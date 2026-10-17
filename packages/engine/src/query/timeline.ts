// Track timeline lane: CPU activity buckets, task blocks, GC and loop-delay markers.

import { Origin, TaskKind } from '../model.js';
import type { ExecutionModel } from '../model.js';
import type { TimelineLane, TimelineMarker, TimelineOptions, TimelineTaskBlock } from './types.js';
import { trackAt } from './track-at.js';

export function timelineLane(
  model: ExecutionModel,
  trackIndex: number,
  options: TimelineOptions = {},
): TimelineLane {
  const track = trackAt(model, trackIndex);
  const buckets = Math.max(1, options.buckets ?? 120);
  const start = options.start ?? 0;
  const end = options.end ?? Math.max(model.meta.durationUs, start + 1);
  const longUs = options.longTaskUs ?? 50_000;
  const bucketUs = (end - start) / buckets;
  const cpu = new Float32Array(buckets);
  const user = new Float32Array(buckets);

  const { samples, callTree } = track;
  for (let i = 0; i < samples.length; i++) {
    const a = samples.time[i] ?? 0;
    const b = a + (samples.dur[i] ?? 0);
    if (b <= start || a >= end) continue;
    const fn = callTree.fn[samples.node[i] ?? 0] ?? 0;
    const origin = model.functions.origin[fn] ?? Origin.User;
    if (origin === Origin.Idle) continue;
    const isUser = origin === Origin.User;
    for (let k = Math.max(0, Math.floor((a - start) / bucketUs)); k < buckets; k++) {
      const lo = start + k * bucketUs;
      if (lo >= b) break;
      const overlap = (Math.min(b, lo + bucketUs, end) - Math.max(a, lo)) / bucketUs;
      if (overlap <= 0) continue;
      cpu[k] = (cpu[k] ?? 0) + overlap;
      if (isUser) user[k] = (user[k] ?? 0) + overlap;
    }
  }
  for (let k = 0; k < buckets; k++) {
    cpu[k] = Math.min(1, cpu[k] ?? 0);
    user[k] = Math.min(1, user[k] ?? 0);
  }

  const tasks: TimelineTaskBlock[] = [];
  for (let k = 0; k < track.tasks.length; k++) {
    const a = track.tasks.start[k] ?? 0;
    const b = track.tasks.end[k] ?? 0;
    if (b <= start || a >= end) continue;
    const kind = (track.tasks.kind[k] ?? TaskKind.Other) as TimelineTaskBlock['kind'];
    tasks.push({
      task: k,
      start: a,
      end: b,
      kind,
      label: model.strings[track.tasks.label[k] ?? 0] ?? '',
      long: b - a > longUs && kind !== TaskKind.Main,
    });
  }

  const gc: TimelineMarker[] = [];
  const g = track.events.gc;
  for (let i = 0; i < g.time.length; i++) {
    const t = g.time[i] ?? 0;
    if (t >= start && t < end) gc.push({ time: t, durationUs: g.duration[i] ?? 0 });
  }
  const loopDelay: TimelineMarker[] = [];
  const l = track.events.loop;
  for (let i = 0; i < l.time.length; i++) {
    const t = l.time[i] ?? 0;
    if (t >= start && t < end && (l.p99[i] ?? 0) > 0) {
      loopDelay.push({ time: t, durationUs: l.p99[i] ?? 0 });
    }
  }

  return { trackIndex, start, end, cpu, user, tasks, gc, loopDelay, bucketUs };
}
