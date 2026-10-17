// Pass 7b: inferred continuation stitching. A sampled profile has no async parents: after its first
// `await`, an async function resumes as a promise continuation whose stack is rooted at a runtime
// frame, not at its caller. The same function resuming is a strong signal that it continues the
// call it made earlier, so its logical parent is that earlier call's parent. Real async hook edges
// take precedence. The result is data only (task columns and a continuation table); the
// `stitch-continuations` transform grafts the stacks.
//
// Principle: never guess an implausible parent. A continuation resumes the OLDEST earlier call of its
// function that was not resumed yet (calls started in a burst resume in call order), and a task with
// nothing to resume is attached, when at all, under the shallowest frame of the same package of where
// the previous task yielded. Otherwise it stays a root.

import { Origin, TaskKind } from '../model.js';
import type { AsyncEdgeTable, ContinuationTable, SpanTable, TaskTable } from '../model.js';

export interface ContinuationInput {
  spans: SpanTable;
  /** Patched in place: parentSpan, resumeOf, waitUs, stitch, resumedFn, runtimeOnly. */
  tasks: TaskTable;
  asyncEdges: AsyncEdgeTable;
  functions: { origin: Uint8Array; plumbing: Uint8Array; loader: Uint8Array; pkg: Uint32Array };
  precisionUs: number;
}

/** Candidates compared per lookup: the latest few calls of a function are enough to pick the right one. */
const LOOKBACK = 64;

export function stitchContinuations(input: ContinuationInput): ContinuationTable {
  const { spans, tasks, asyncEdges, functions, precisionUs } = input;
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
  const consumed = new Set<number>();
  const headOf = new Map<number, number>();
  const segmentOfSpan = new Map<number, number>();
  const cTask: number[] = [];
  const cFn: number[] = [];
  const cSpan: number[] = [];
  const cParent: number[] = [];
  const cResume: number[] = [];
  const cWait: number[] = [];
  const cStitch: number[] = [];

  const edgesTo = new Map<number, number[]>();
  const edgeWait = new Map<number, Map<number, number>>();
  for (let e = 0; e < asyncEdges.length; e++) {
    const to = asyncEdges.to[e] ?? 0;
    const list = edgesTo.get(to);
    if (list) list.push(asyncEdges.from[e] ?? 0);
    else edgesTo.set(to, [asyncEdges.from[e] ?? 0]);
    const waits = edgeWait.get(to) ?? new Map<number, number>();
    waits.set(asyncEdges.from[e] ?? 0, asyncEdges.waitUs[e] ?? 0);
    edgeWait.set(to, waits);
  }

  const taskOfSpan = (span: number): number => {
    let lo = 0;
    let hi = tasks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((tasks.spanStart[mid] ?? 0) <= span) lo = mid + 1;
      else hi = mid;
    }
    const k = lo - 1;
    return k >= 0 && span < (tasks.spanEnd[k] ?? 0) ? k : -1;
  };
  const segmentOfTaskFn = new Map<number, number>();
  const FN_RANGE = functions.origin.length + 1;
  const isLoader = (s: number): boolean => functions.loader[spans.fn[s] ?? 0] === 1;

  /** Spans from the root of the logical call path down to `span`: stitched segments hang under their parent. */
  const logicalChain = (span: number): number[] => {
    const own: number[] = [];
    for (let x = span; x >= 0; x = spans.parent[x] ?? -1) own.push(x);
    own.reverse();
    const at = own.findIndex((x) => anchor[x] === 1);
    if (at < 0) return own;
    const head = own[at] ?? 0;
    const seg = segmentOfTaskFn.get(taskOfSpan(head) * FN_RANGE + (spans.fn[head] ?? 0));
    if (seg === undefined || (cStitch[seg] ?? 0) === 0) return own;
    const parent = cParent[seg] ?? -1;
    return [...(parent >= 0 ? logicalChain(parent) : []), ...own.slice(at)];
  };

  // Where task P was when it ended: its last stack, as a logical call path.
  const yieldMemo = new Map<number, number[]>();
  const yieldChainOf = (p: number): number[] => {
    const known = yieldMemo.get(p);
    if (known) return known;
    const endAt = (tasks.end[p] ?? 0) - 1;
    let deepest = -1;
    for (let s = tasks.spanStart[p] ?? 0; s < (tasks.spanEnd[p] ?? 0); s++) {
      if (
        (spans.end[s] ?? 0) >= endAt &&
        (deepest < 0 || (spans.depth[s] ?? 0) > (spans.depth[deepest] ?? 0))
      ) {
        deepest = s;
      }
    }
    const chain = deepest < 0 ? [] : logicalChain(deepest);
    // The last run of loader frames is module loading; it and everything below it is not what yielded.
    // A run that starts the stack is the entry module wrapping the program, not loading.
    let cut = chain.length;
    for (let i = chain.length - 1; i > 0; i--) {
      if (!isLoader(chain[i] ?? 0)) continue;
      let start = i;
      while (start > 0 && isLoader(chain[start - 1] ?? 0)) start--;
      if (start > 0) cut = start;
      break;
    }
    const out = chain.slice(0, cut).filter((s) => !runtime(spans.fn[s] ?? 0) && !isLoader(s));
    yieldMemo.set(p, out);
    return out;
  };
  // The last task that resumes each function: only a function that resumes later can have awaited.
  const lastResumed = new Map<number, number>();
  for (let k = 0; k < tasks.length; k++) {
    for (let x = tasks.spanStart[k] ?? 0; x < (tasks.spanEnd[k] ?? 0); x++) {
      if (anchor[x] === 1) lastResumed.set(spans.fn[x] ?? 0, k);
    }
  }
  /**
   * Where a task that resumes `fn` hangs when task `p` yielded: among the frames of the same package of `p`'s last
   * stack that `fn`'s own task does not call itself, the deepest one whose function resumes later (an async
   * function, the only kind that can have awaited), else the shallowest. -1 when there is none.
   */
  const yieldSpanOf = (p: number, fn: number, task: number): number => {
    const pkg = functions.pkg[fn] ?? 0;
    const own = new Set<number>();
    for (let x = tasks.spanStart[task] ?? 0; x < (tasks.spanEnd[task] ?? 0); x++) {
      own.add(spans.fn[x] ?? 0);
    }
    let shallowest = -1;
    let asyncDeepest = -1;
    for (const x of yieldChainOf(p)) {
      const f = spans.fn[x] ?? 0;
      if ((functions.pkg[f] ?? 0) !== pkg || own.has(f)) continue;
      if (shallowest < 0) shallowest = x;
      if ((lastResumed.get(f) ?? -1) > p) asyncDeepest = x;
    }
    return asyncDeepest >= 0 ? asyncDeepest : shallowest;
  };
  const yieldCandidate = (k: number, fn: number): { span: number; task: number } | undefined => {
    const kind = tasks.kind[k];
    // Timer, I/O and request entries have no caller. Loading a module (a dynamic import) is a root too.
    if (kind !== TaskKind.Microtask && kind !== TaskKind.Other && kind !== TaskKind.Main) {
      return undefined;
    }
    if (functions.loader[fn] === 1) return undefined;
    const waits = edgeWait.get(k);
    if (waits) {
      // The exact edge with the smallest wait, then the latest scheduler.
      const from = [...waits.keys()].sort(
        (a, b) => (waits.get(a) ?? 0) - (waits.get(b) ?? 0) || b - a,
      );
      for (const f of from) {
        const span = yieldSpanOf(f, fn, k);
        if (span >= 0) return { span, task: f };
      }
    }
    // Without an edge, the task right before it, when it follows closely.
    for (let j = k - 1; j >= 0; j--) {
      if (tasks.runtimeOnly[j] === 1) continue;
      if ((tasks.start[k] ?? 0) - (tasks.end[j] ?? 0) > 2 * precisionUs) return undefined;
      const span = yieldSpanOf(j, fn, k);
      return span >= 0 ? { span, task: j } : undefined;
    }
    return undefined;
  };

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
      // A span can be resumed once: a stitched segment is usable at any depth, a plain call needs a caller.
      const usable = (x: number): boolean => {
        if ((spans.end[x] ?? 0) > startedAt) return false;
        if ((spans.depth[x] ?? 0) >= 1) return true;
        const sg = segmentOfSpan.get(x);
        return sg !== undefined && (cStitch[sg] ?? 0) > 0;
      };
      const oldest = (list: number[], from0: number): number => {
        for (let i = from0; i < list.length; i++) {
          const x = list[i] ?? 0;
          if ((spans.end[x] ?? 0) > startedAt) break;
          if (!consumed.has(x) && usable(x)) return x;
        }
        return -1;
      };
      for (const scheduler of edgesTo.get(k) ?? []) {
        const inTask: number[] = [];
        for (let x = tasks.spanStart[scheduler] ?? 0; x < (tasks.spanEnd[scheduler] ?? 0); x++) {
          if (spans.fn[x] === fn) inTask.push(x);
        }
        let pick = oldest(inTask, 0);
        if (pick < 0) {
          for (const x of inTask) if (usable(x) && better(x, pick)) pick = x;
        }
        if (pick >= 0 && (source < 0 || better(pick, source))) {
          source = pick;
          kind = 2;
        }
      }
      if (source < 0) {
        const list = byFn.get(fn) ?? [];
        let head = headOf.get(fn) ?? 0;
        while (head < list.length && consumed.has(list[head] ?? 0)) head++;
        headOf.set(fn, head);
        source = oldest(list, head);
        // Nothing unresumed left (more continuations than sampled calls): sit next to the latest call.
        if (source < 0) {
          for (let i = list.length - 1, seen = 0; i >= 0 && seen < LOOKBACK; i--, seen++) {
            const x = list[i] ?? 0;
            if (usable(x) && better(x, source)) source = x;
          }
        }
        if (source >= 0) kind = 1;
      }
      if (source >= 0) consumed.add(source);
      // No earlier call to resume: attach where the previous task yielded (inferred from adjacency).
      let yielded: { span: number; task: number } | undefined;
      if (source < 0) yielded = yieldCandidate(k, fn);
      if (yielded) kind = 3;
      // An earlier segment that was itself stitched already knows the logical parent.
      const seg = source >= 0 ? segmentOfSpan.get(source) : undefined;
      const stitchedSeg = seg !== undefined && (cStitch[seg] ?? 0) > 0;
      const parent = yielded
        ? yielded.span
        : source < 0
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
      cWait.push(
        yielded
          ? Math.max(0, startedAt - (tasks.end[yielded.task] ?? startedAt))
          : source < 0
            ? 0
            : Math.max(0, startedAt - (spans.end[source] ?? 0)),
      );
      cStitch.push(yielded ? 3 : source < 0 ? 0 : kind);
      segmentOfSpan.set(a, index);
      segmentOfTaskFn.set(k * FN_RANGE + fn, index);
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
      // Only calls that can ever be resumed are kept, so the queue head never sticks on a dead span.
      const sg = segmentOfSpan.get(s);
      if ((spans.depth[s] ?? 0) < 1 && !(sg !== undefined && (cStitch[sg] ?? 0) > 0)) continue;
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
