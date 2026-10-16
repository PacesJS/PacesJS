// Pass 7b: inferred continuation stitching. A sampled profile has no async parents: after its first
// `await`, an async function resumes as a promise continuation whose stack is rooted at a runtime
// frame, not at its caller. The same function resuming is a strong signal that it continues the
// call it made earlier, so its logical parent is that earlier call's parent. Real async hook edges
// take precedence. The result is data only (task columns and a continuation table); the
// `stitch-continuations` transform grafts the stacks.

import { Origin } from '../model.js';
import type { AsyncEdgeTable, ContinuationTable, SpanTable, TaskTable } from '../model.js';

export interface ContinuationInput {
  spans: SpanTable;
  /** Patched in place: parentSpan, resumeOf, waitUs, stitch, resumedFn, runtimeOnly. */
  tasks: TaskTable;
  asyncEdges: AsyncEdgeTable;
  functions: { origin: Uint8Array; plumbing: Uint8Array };
}

/** Candidates compared per lookup: the latest few calls of a function are enough to pick the right one. */
const LOOKBACK = 64;

export function stitchContinuations(input: ContinuationInput): ContinuationTable {
  const { spans, tasks, asyncEdges, functions } = input;
  const runtime = (fn: number): boolean => {
    const o = functions.origin[fn] ?? Origin.User;
    return (
      o === Origin.Native ||
      o === Origin.Node ||
      o === Origin.Idle ||
      o === Origin.Gc ||
      functions.plumbing[fn] === 1
    );
  };

  // A span is an anchor when it is the shallowest program frame on its stack.
  const anchor = new Uint8Array(spans.length);
  const underProgram = new Uint8Array(spans.length);
  for (let s = 0; s < spans.length; s++) {
    const p = spans.parent[s] ?? -1;
    const above = p >= 0 ? (underProgram[p] ?? 0) : 0;
    const program = !runtime(spans.fn[s] ?? 0);
    anchor[s] = program && above === 0 ? 1 : 0;
    underProgram[s] = above | (program ? 1 : 0);
  }

  const byFn = new Map<number, number[]>();
  const segmentOfSpan = new Map<number, number>();
  const cTask: number[] = [];
  const cFn: number[] = [];
  const cSpan: number[] = [];
  const cParent: number[] = [];
  const cResume: number[] = [];
  const cWait: number[] = [];
  const cStitch: number[] = [];

  const edgesTo = new Map<number, number[]>();
  for (let e = 0; e < asyncEdges.length; e++) {
    const to = asyncEdges.to[e] ?? 0;
    const list = edgesTo.get(to);
    if (list) list.push(asyncEdges.from[e] ?? 0);
    else edgesTo.set(to, [asyncEdges.from[e] ?? 0]);
  }

  const better = (a: number, b: number): boolean =>
    b < 0 ||
    (spans.end[a] ?? 0) > (spans.end[b] ?? 0) ||
    ((spans.end[a] ?? 0) === (spans.end[b] ?? 0) && (spans.depth[a] ?? 0) > (spans.depth[b] ?? 0));

  for (let k = 0; k < tasks.length; k++) {
    const from = tasks.spanStart[k] ?? 0;
    const to = tasks.spanEnd[k] ?? 0;
    const firstOfFn = new Map<number, number>();
    for (let s = from; s < to; s++) {
      if (anchor[s] === 1 && !firstOfFn.has(spans.fn[s] ?? 0)) firstOfFn.set(spans.fn[s] ?? 0, s);
    }
    tasks.runtimeOnly[k] = firstOfFn.size === 0 ? 1 : 0;
    let firstSegment = -1;
    for (const [fn, a] of firstOfFn) {
      const startedAt = spans.start[a] ?? 0;
      let source = -1;
      let kind = 0;
      for (const scheduler of edgesTo.get(k) ?? []) {
        for (let s = tasks.spanStart[scheduler] ?? 0; s < (tasks.spanEnd[scheduler] ?? 0); s++) {
          if (
            spans.fn[s] === fn &&
            (spans.depth[s] ?? 0) >= 1 &&
            (spans.end[s] ?? 0) <= startedAt &&
            better(s, source)
          ) {
            source = s;
            kind = 2;
          }
        }
      }
      if (source < 0) {
        const list = byFn.get(fn) ?? [];
        for (let i = list.length - 1, seen = 0; i >= 0 && seen < LOOKBACK; i--, seen++) {
          const s = list[i] ?? 0;
          if ((spans.depth[s] ?? 0) < 1 || (spans.end[s] ?? 0) > startedAt) continue;
          if (better(s, source)) {
            source = s;
            kind = 1;
          }
        }
      }
      // An earlier segment that was itself stitched already knows the logical parent.
      const seg = source >= 0 ? segmentOfSpan.get(source) : undefined;
      const stitchedSeg = seg !== undefined && (cStitch[seg] ?? 0) > 0;
      const parent =
        source < 0
          ? -1
          : stitchedSeg && seg !== undefined
            ? (cParent[seg] ?? -1)
            : (spans.parent[source] ?? -1);
      const index = cTask.length;
      cTask.push(k);
      cFn.push(fn);
      cSpan.push(a);
      cParent.push(parent);
      cResume.push(source);
      cWait.push(source < 0 ? 0 : Math.max(0, startedAt - (spans.end[source] ?? 0)));
      cStitch.push(source < 0 ? 0 : kind);
      segmentOfSpan.set(a, index);
      if (firstSegment < 0) firstSegment = index;
    }
    if (firstSegment >= 0) {
      tasks.resumedFn[k] = cFn[firstSegment] ?? -1;
      tasks.parentSpan[k] = cParent[firstSegment] ?? -1;
      tasks.resumeOf[k] = cResume[firstSegment] ?? -1;
      tasks.waitUs[k] = cWait[firstSegment] ?? 0;
      tasks.stitch[k] = cStitch[firstSegment] ?? 0;
    }
    for (let s = from; s < to; s++) {
      const fn = spans.fn[s] ?? 0;
      const list = byFn.get(fn);
      if (list) list.push(s);
      else byFn.set(fn, [s]);
    }
  }

  // Only stitched segments are interesting to consumers; unstitched ones stay in the task columns.
  const keep: number[] = [];
  cStitch.forEach((st, i) => {
    if (st > 0) keep.push(i);
  });
  return {
    length: keep.length,
    task: Uint32Array.from(keep, (i) => cTask[i] ?? 0),
    fn: Uint32Array.from(keep, (i) => cFn[i] ?? 0),
    span: Uint32Array.from(keep, (i) => cSpan[i] ?? 0),
    parentSpan: Int32Array.from(keep, (i) => cParent[i] ?? -1),
    resumeOf: Int32Array.from(keep, (i) => cResume[i] ?? -1),
    waitUs: Float64Array.from(keep, (i) => cWait[i] ?? 0),
    stitch: Uint8Array.from(keep, (i) => cStitch[i] ?? 0),
  };
}
