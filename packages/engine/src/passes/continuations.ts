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

import { isRuntimeFn } from '../frames.js';
import { TaskKind } from '../model.js';
import type { AsyncEdgeTable, ContinuationTable, SpanTable, TaskTable } from '../model.js';
import { taskOfSpan } from '../util/search.js';

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

type Functions = ContinuationInput['functions'];

/** The table being built (one entry per segment, stitched or not) and the indexes the lookups need. */
interface Stitcher {
  spans: SpanTable;
  tasks: TaskTable;
  functions: Functions;
  precisionUs: number;
  /** 1 = the shallowest program frame on its stack. */
  anchor: Uint8Array;
  edgesTo: Map<number, number[]>;
  edgeWait: Map<number, Map<number, number>>;
  /** The last task that resumes each function: only a function that resumes later can have awaited. */
  lastResumed: Map<number, number>;
  fnRange: number;
  /** Calls that can still be resumed, per function, in span order. */
  byFn: Map<number, number[]>;
  consumed: Set<number>;
  headOf: Map<number, number>;
  segmentOfSpan: Map<number, number>;
  segmentOfTaskFn: Map<number, number>;
  yieldMemo: Map<number, number[]>;
  cTask: number[];
  cFn: number[];
  cSpan: number[];
  cParent: number[];
  cResume: number[];
  cWait: number[];
  cStitch: number[];
}

/** A span is an anchor when it is the shallowest program frame on its stack. */
function markAnchors(spans: SpanTable, functions: Functions): Uint8Array {
  const anchor = new Uint8Array(spans.length);
  const underProgram = new Uint8Array(spans.length);
  for (let s = 0; s < spans.length; s++) {
    const p = spans.parent[s] ?? -1;
    const above = p >= 0 ? (underProgram[p] ?? 0) : 0;
    const program = !isRuntimeFn(functions, spans.fn[s] ?? 0);
    anchor[s] = program && above === 0 ? 1 : 0;
    underProgram[s] = above | (program ? 1 : 0);
  }
  return anchor;
}

function indexAsyncEdges(asyncEdges: AsyncEdgeTable): Pick<Stitcher, 'edgesTo' | 'edgeWait'> {
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
  return { edgesTo, edgeWait };
}

function lastResumedTasks(
  tasks: TaskTable,
  spans: SpanTable,
  anchor: Uint8Array,
): Map<number, number> {
  const lastResumed = new Map<number, number>();
  for (let k = 0; k < tasks.length; k++) {
    for (let x = tasks.spanStart[k] ?? 0; x < (tasks.spanEnd[k] ?? 0); x++) {
      if (anchor[x] === 1) lastResumed.set(spans.fn[x] ?? 0, k);
    }
  }
  return lastResumed;
}

const isLoader = (st: Stitcher, s: number): boolean =>
  st.functions.loader[st.spans.fn[s] ?? 0] === 1;

/** Spans from the root of the logical call path down to `span`: stitched segments hang under their parent. */
function logicalChain(st: Stitcher, span: number): number[] {
  const { spans, tasks } = st;
  const own: number[] = [];
  for (let x = span; x >= 0; x = spans.parent[x] ?? -1) own.push(x);
  own.reverse();
  const at = own.findIndex((x) => st.anchor[x] === 1);
  if (at < 0) return own;
  const head = own[at] ?? 0;
  const seg = st.segmentOfTaskFn.get(taskOfSpan(tasks, head) * st.fnRange + (spans.fn[head] ?? 0));
  if (seg === undefined || (st.cStitch[seg] ?? 0) === 0) return own;
  const parent = st.cParent[seg] ?? -1;
  return [...(parent >= 0 ? logicalChain(st, parent) : []), ...own.slice(at)];
}

/** Where task `p` was when it ended: its last stack, as a logical call path. */
function yieldChainOf(st: Stitcher, p: number): number[] {
  const known = st.yieldMemo.get(p);
  if (known) return known;
  const { spans, tasks } = st;
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
  const chain = deepest < 0 ? [] : logicalChain(st, deepest);
  // The last run of loader frames is module loading; it and everything below it is not what yielded.
  // A run that starts the stack is the entry module wrapping the program, not loading.
  let cut = chain.length;
  for (let i = chain.length - 1; i > 0; i--) {
    if (!isLoader(st, chain[i] ?? 0)) continue;
    let start = i;
    while (start > 0 && isLoader(st, chain[start - 1] ?? 0)) start--;
    if (start > 0) cut = start;
    break;
  }
  const out = chain
    .slice(0, cut)
    .filter((s) => !isRuntimeFn(st.functions, spans.fn[s] ?? 0) && !isLoader(st, s));
  st.yieldMemo.set(p, out);
  return out;
}

/**
 * Where a task that resumes `fn` hangs when task `p` yielded: among the frames of the same package of `p`'s last
 * stack that `fn`'s own task does not call itself, the deepest one whose function resumes later (an async
 * function, the only kind that can have awaited), else the shallowest. -1 when there is none.
 */
function yieldSpanOf(st: Stitcher, p: number, fn: number, task: number): number {
  const { spans, tasks, functions } = st;
  const pkg = functions.pkg[fn] ?? 0;
  const own = new Set<number>();
  for (let x = tasks.spanStart[task] ?? 0; x < (tasks.spanEnd[task] ?? 0); x++) {
    own.add(spans.fn[x] ?? 0);
  }
  let shallowest = -1;
  let asyncDeepest = -1;
  for (const x of yieldChainOf(st, p)) {
    const f = spans.fn[x] ?? 0;
    if ((functions.pkg[f] ?? 0) !== pkg || own.has(f)) continue;
    if (shallowest < 0) shallowest = x;
    if ((st.lastResumed.get(f) ?? -1) > p) asyncDeepest = x;
  }
  return asyncDeepest >= 0 ? asyncDeepest : shallowest;
}

function yieldCandidate(
  st: Stitcher,
  k: number,
  fn: number,
): { span: number; task: number } | undefined {
  const { tasks, functions } = st;
  const kind = tasks.kind[k];
  // Timer, I/O and request entries have no caller. Loading a module (a dynamic import) is a root too.
  if (kind !== TaskKind.Microtask && kind !== TaskKind.Other && kind !== TaskKind.Main) {
    return undefined;
  }
  if (functions.loader[fn] === 1) return undefined;
  const waits = st.edgeWait.get(k);
  if (waits) {
    // The exact edge with the smallest wait, then the latest scheduler.
    const from = [...waits.keys()].sort(
      (a, b) => (waits.get(a) ?? 0) - (waits.get(b) ?? 0) || b - a,
    );
    for (const f of from) {
      const span = yieldSpanOf(st, f, fn, k);
      if (span >= 0) return { span, task: f };
    }
  }
  // Without an edge, the task right before it, when it follows closely.
  for (let j = k - 1; j >= 0; j--) {
    if (tasks.runtimeOnly[j] === 1) continue;
    if ((tasks.start[k] ?? 0) - (tasks.end[j] ?? 0) > 2 * st.precisionUs) return undefined;
    const span = yieldSpanOf(st, j, fn, k);
    return span >= 0 ? { span, task: j } : undefined;
  }
  return undefined;
}

/** `a` is the better resume source than `b`: it ended later, or equally late but deeper. */
function better(spans: SpanTable, a: number, b: number): boolean {
  return (
    b < 0 ||
    (spans.end[a] ?? 0) > (spans.end[b] ?? 0) ||
    ((spans.end[a] ?? 0) === (spans.end[b] ?? 0) && (spans.depth[a] ?? 0) > (spans.depth[b] ?? 0))
  );
}

/**
 * The earlier call that the first call of `fn` in task `k` (starting with span `a`) resumes, and how it was
 * found (2 = a real async edge, 1 = the oldest unresumed call of `fn`); -1 when there is none.
 */
function resumeSource(
  st: Stitcher,
  k: number,
  fn: number,
  a: number,
): { source: number; kind: number } {
  const { spans, tasks } = st;
  const startedAt = spans.start[a] ?? 0;
  let source = -1;
  let kind = 0;
  // A span can be resumed once: a stitched segment is usable at any depth, a plain call needs a caller.
  const usable = (x: number): boolean => {
    if ((spans.end[x] ?? 0) > startedAt) return false;
    if ((spans.depth[x] ?? 0) >= 1) return true;
    const sg = st.segmentOfSpan.get(x);
    return sg !== undefined && (st.cStitch[sg] ?? 0) > 0;
  };
  const oldest = (list: number[], from0: number): number => {
    for (let i = from0; i < list.length; i++) {
      const x = list[i] ?? 0;
      if ((spans.end[x] ?? 0) > startedAt) break;
      if (!st.consumed.has(x) && usable(x)) return x;
    }
    return -1;
  };
  for (const scheduler of st.edgesTo.get(k) ?? []) {
    const inTask: number[] = [];
    for (let x = tasks.spanStart[scheduler] ?? 0; x < (tasks.spanEnd[scheduler] ?? 0); x++) {
      if (spans.fn[x] === fn) inTask.push(x);
    }
    let pick = oldest(inTask, 0);
    if (pick < 0) {
      for (const x of inTask) if (usable(x) && better(spans, x, pick)) pick = x;
    }
    if (pick >= 0 && (source < 0 || better(spans, pick, source))) {
      source = pick;
      kind = 2;
    }
  }
  if (source < 0) {
    const list = st.byFn.get(fn) ?? [];
    let head = st.headOf.get(fn) ?? 0;
    while (head < list.length && st.consumed.has(list[head] ?? 0)) head++;
    st.headOf.set(fn, head);
    source = oldest(list, head);
    // Nothing unresumed left (more continuations than sampled calls): sit next to the latest call.
    if (source < 0) {
      for (let i = list.length - 1, seen = 0; i >= 0 && seen < LOOKBACK; i--, seen++) {
        const x = list[i] ?? 0;
        if (usable(x) && better(spans, x, source)) source = x;
      }
    }
    if (source >= 0) kind = 1;
  }
  return { source, kind };
}

/** Records the segment that starts with span `a` (the first call of `fn` in task `k`); returns its index. */
function addSegment(st: Stitcher, k: number, fn: number, a: number): number {
  const { spans, tasks } = st;
  const startedAt = spans.start[a] ?? 0;
  const found = resumeSource(st, k, fn, a);
  const { source } = found;
  let { kind } = found;
  if (source >= 0) st.consumed.add(source);
  // No earlier call to resume: attach where the previous task yielded (inferred from adjacency).
  let yielded: { span: number; task: number } | undefined;
  if (source < 0) yielded = yieldCandidate(st, k, fn);
  if (yielded) kind = 3;
  // An earlier segment that was itself stitched already knows the logical parent.
  const seg = source >= 0 ? st.segmentOfSpan.get(source) : undefined;
  const stitchedSeg = seg !== undefined && (st.cStitch[seg] ?? 0) > 0;
  const parent = yielded
    ? yielded.span
    : source < 0
      ? -1
      : stitchedSeg && seg !== undefined
        ? (st.cParent[seg] ?? -1)
        : (spans.parent[source] ?? -1);
  const index = st.cTask.length;
  st.cTask.push(k);
  st.cFn.push(fn);
  st.cSpan.push(a);
  st.cParent.push(parent);
  st.cResume.push(source);
  st.cWait.push(
    yielded
      ? Math.max(0, startedAt - (tasks.end[yielded.task] ?? startedAt))
      : source < 0
        ? 0
        : Math.max(0, startedAt - (spans.end[source] ?? 0)),
  );
  st.cStitch.push(yielded ? 3 : source < 0 ? 0 : kind);
  st.segmentOfSpan.set(a, index);
  st.segmentOfTaskFn.set(k * st.fnRange + fn, index);
  return index;
}

export function stitchContinuations(input: ContinuationInput): ContinuationTable {
  const { spans, tasks, asyncEdges, functions, precisionUs } = input;
  const anchor = markAnchors(spans, functions);
  const st: Stitcher = {
    spans,
    tasks,
    functions,
    precisionUs,
    anchor,
    ...indexAsyncEdges(asyncEdges),
    lastResumed: lastResumedTasks(tasks, spans, anchor),
    fnRange: functions.origin.length + 1,
    byFn: new Map(),
    consumed: new Set(),
    headOf: new Map(),
    segmentOfSpan: new Map(),
    segmentOfTaskFn: new Map(),
    yieldMemo: new Map(),
    cTask: [],
    cFn: [],
    cSpan: [],
    cParent: [],
    cResume: [],
    cWait: [],
    cStitch: [],
  };

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
      const index = addSegment(st, k, fn, a);
      if (firstSegment < 0) firstSegment = index;
    }
    if (firstSegment >= 0) {
      tasks.resumedFn[k] = st.cFn[firstSegment] ?? -1;
      tasks.parentSpan[k] = st.cParent[firstSegment] ?? -1;
      tasks.resumeOf[k] = st.cResume[firstSegment] ?? -1;
      tasks.waitUs[k] = st.cWait[firstSegment] ?? 0;
      tasks.stitch[k] = st.cStitch[firstSegment] ?? 0;
    }
    for (let s = from; s < to; s++) {
      // Only calls that can ever be resumed are kept, so the queue head never sticks on a dead span.
      const sg = st.segmentOfSpan.get(s);
      if ((spans.depth[s] ?? 0) < 1 && !(sg !== undefined && (st.cStitch[sg] ?? 0) > 0)) continue;
      const fn = spans.fn[s] ?? 0;
      const list = st.byFn.get(fn);
      if (list) list.push(s);
      else st.byFn.set(fn, [s]);
    }
  }

  // Only stitched segments are interesting to consumers; unstitched ones stay in the task columns.
  const keep: number[] = [];
  st.cStitch.forEach((stitch, i) => {
    if (stitch > 0) keep.push(i);
  });
  return {
    length: keep.length,
    task: Uint32Array.from(keep, (i) => st.cTask[i] ?? 0),
    fn: Uint32Array.from(keep, (i) => st.cFn[i] ?? 0),
    span: Uint32Array.from(keep, (i) => st.cSpan[i] ?? 0),
    parentSpan: Int32Array.from(keep, (i) => st.cParent[i] ?? -1),
    resumeOf: Int32Array.from(keep, (i) => st.cResume[i] ?? -1),
    waitUs: Float64Array.from(keep, (i) => st.cWait[i] ?? 0),
    stitch: Uint8Array.from(keep, (i) => st.cStitch[i] ?? 0),
  };
}
