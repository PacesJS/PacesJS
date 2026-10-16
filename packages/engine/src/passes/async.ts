// Pass 7: async stitching. With `--async` data, map tasks to async ids by aligning before/after
// hooks with task times, and record which task scheduled which. Without it the edge table is empty.

import type { AsyncEdgeTable, TaskTable } from '../model.js';
import type { AsyncRecords } from './types.js';

export interface AsyncInput {
  records: AsyncRecords;
  tasks: TaskTable;
}

interface Resource {
  initTime: number;
  trigger: number;
  /** [before, after] pairs, in order. */
  runs: Array<[number, number]>;
}

function emptyEdges(): AsyncEdgeTable {
  return {
    length: 0,
    from: new Uint32Array(0),
    to: new Uint32Array(0),
    waitUs: new Float64Array(0),
  };
}

/** Task with the largest overlap with [a, b], or the one containing `a` when b == a. */
function taskAt(tasks: TaskTable, a: number, b: number): number {
  let best = -1;
  let bestOverlap = 0;
  let lo = 0;
  let hi = tasks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((tasks.end[mid] ?? 0) <= a) lo = mid + 1;
    else hi = mid;
  }
  for (let k = lo; k < tasks.length && (tasks.start[k] ?? 0) <= Math.max(b, a); k++) {
    const overlap = Math.min(b, tasks.end[k] ?? 0) - Math.max(a, tasks.start[k] ?? 0);
    if (overlap > bestOverlap || (best < 0 && overlap >= 0 && b === a)) {
      best = k;
      bestOverlap = overlap;
    }
  }
  return best;
}

export function stitchAsync(input: AsyncInput): AsyncEdgeTable {
  const { records, tasks } = input;
  if (records.length === 0 || tasks.length === 0) return emptyEdges();

  const resources = new Map<number, Resource>();
  const pending = new Map<number, number>();
  for (let i = 0; i < records.length; i++) {
    const id = records.asyncId[i] ?? 0;
    const time = records.time[i] ?? 0;
    const phase = records.phase[i] ?? 0;
    if (phase === 0) {
      resources.set(id, {
        initTime: time,
        trigger: records.triggerAsyncId[i] ?? 0,
        runs: [],
      });
    } else if (phase === 1) pending.set(id, time);
    else if (phase === 2) {
      const began = pending.get(id);
      const r = resources.get(id);
      if (began !== undefined && r) r.runs.push([began, time]);
      pending.delete(id);
    }
  }

  // The task each resource ran in, by its first run.
  const ranIn = new Map<number, number>();
  for (const [id, r] of resources) {
    const run = r.runs[0];
    if (!run) continue;
    const task = taskAt(tasks, run[0], run[1]);
    if (task >= 0) ranIn.set(id, task);
  }

  const edges = new Map<number, { from: number; to: number; wait: number }>();
  for (const [id, r] of resources) {
    const to = ranIn.get(id);
    if (to === undefined) continue;
    let from = taskAt(tasks, r.initTime, r.initTime);
    if (from < 0) from = ranIn.get(r.trigger) ?? -1;
    if (from < 0 || from === to) continue;
    const wait = Math.max(0, (tasks.start[to] ?? 0) - (tasks.end[from] ?? 0));
    const key = from * tasks.length + to;
    const known = edges.get(key);
    if (!known || wait < known.wait) edges.set(key, { from, to, wait });
  }

  const sorted = [...edges.values()].sort((a, b) => a.from - b.from || a.to - b.to);
  return {
    length: sorted.length,
    from: Uint32Array.from(sorted, (e) => e.from),
    to: Uint32Array.from(sorted, (e) => e.to),
    waitUs: Float64Array.from(sorted, (e) => e.wait),
  };
}
