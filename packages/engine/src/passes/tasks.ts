// Pass 6: split each track into tasks, the top-level units of work. A task ends at an idle
// sample, at a change of entry frame (processTicksAndRejections, listOnTimeout, an I/O callback)
// and at the edges of a request window, so back-to-back requests never merge.

import { Origin, TaskKind } from '../model.js';
import type { CallTree, EventTable, Samples, SpanTable, TaskKindId, TaskTable } from '../model.js';
import type { PassContext } from './types.js';

export interface TaskFunctions {
  name: Uint32Array;
  file: Uint32Array;
  origin: Uint8Array;
  plumbing: Uint8Array;
}

export interface TaskInput {
  tree: CallTree;
  samples: Samples;
  spans: SpanTable;
  functions: TaskFunctions;
  requests: EventTable['requests'];
}

export interface TaskResult {
  table: TaskTable;
  /** Sample index range of each task: [sampleStart, sampleEnd). */
  sampleStart: Uint32Array;
  sampleEnd: Uint32Array;
}

const TIMER_ENTRIES = new Set(['listOnTimeout', 'processTimers']);
const IMMEDIATE_ENTRIES = new Set(['processImmediate']);
const MICROTASK_ENTRIES = new Set([
  'processTicksAndRejections',
  'runMicrotasks',
  'processPromiseRejections',
]);
const IO_ENTRIES = new Set([
  'parserOnHeadersComplete',
  'parserOnIncoming',
  'parserOnMessageComplete',
  'onStreamRead',
  'onread',
  'afterConnect',
  'afterConnectMultiple',
  'onlookupall',
  'onlookup',
  'onconnection',
  'onclose',
  'oncomplete',
  'afterWrite',
  'emit',
]);
const MAIN_FILE_PREFIXES = [
  'node:internal/main/',
  'node:internal/modules/',
  'node:internal/per_context/',
  'node:internal/process/pre_execution',
];

/** Task label prefix per kind. */
const KIND_PREFIX: Record<number, string> = {
  [TaskKind.Main]: 'main',
  [TaskKind.Request]: 'request',
  [TaskKind.Timer]: 'timer',
  [TaskKind.Immediate]: 'immediate',
  [TaskKind.Microtask]: 'microtasks',
  [TaskKind.Io]: 'I/O',
  [TaskKind.Other]: 'other',
};
const MODULE_PREFIX = /^(require|import) ▸ /;

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

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export function segmentTasks(input: TaskInput, ctx: PassContext): TaskResult {
  const { tree, samples, spans, functions, requests } = input;
  const strings = ctx.strings.strings;
  const nameOf = (fn: number): string => strings[functions.name[fn] ?? 0] ?? '';
  const fileOf = (fn: number): string => strings[functions.file[fn] ?? 0] ?? '';
  const display = (fn: number): string => {
    const name = nameOf(fn);
    if (name) return name;
    const file = basename(fileOf(fn));
    return file ? `(anonymous in ${file})` : '(anonymous)';
  };

  // The function of each node's ancestor directly under the root.
  const entryOf = new Int32Array(tree.length).fill(-1);
  for (let n = 1; n < tree.length; n++) {
    const p = tree.parent[n] ?? 0;
    entryOf[n] = p === 0 ? (tree.fn[n] ?? 0) : (entryOf[p] ?? -1);
  }

  const reqCount = requests.time.length;
  const active: number[] = [];
  let nextReq = 0;

  const startIdx: number[] = [];
  const endIdx: number[] = [];
  const taskReq: number[] = [];
  const taskEntry: number[] = [];
  let open = false;
  let curEntry = -1;
  let curReq = -1;
  let first = 0;
  let last = 0;

  const close = (): void => {
    startIdx.push(first);
    endIdx.push(last + 1);
    taskReq.push(curReq);
    taskEntry.push(curEntry);
    open = false;
  };

  for (let i = 0; i < samples.length; i++) {
    const t = samples.time[i] ?? 0;
    while (nextReq < reqCount && (requests.time[nextReq] ?? 0) <= t) active.push(nextReq++);
    for (let k = active.length - 1; k >= 0; k--) {
      const r = active[k] ?? 0;
      if ((requests.time[r] ?? 0) + (requests.duration[r] ?? 0) <= t) active.splice(k, 1);
    }
    const req = active.length > 0 ? (active[active.length - 1] ?? -1) : -1;

    const entry = entryOf[samples.node[i] ?? 0] ?? -1;
    const entryOrigin = entry >= 0 ? (functions.origin[entry] ?? 0) : Origin.Native;
    if (entryOrigin === Origin.Idle) {
      if (open) close();
      continue;
    }
    const neutral = entry < 0 || entryOrigin === Origin.Gc || nameOf(entry) === '(program)';
    if (neutral) {
      if (open) last = i;
      continue;
    }
    if (open && (entry !== curEntry || req !== curReq)) close();
    if (!open) {
      open = true;
      first = i;
      curEntry = entry;
      curReq = req;
    }
    last = i;
  }
  if (open) close();

  const length = startIdx.length;
  const start = new Float64Array(length);
  const end = new Float64Array(length);
  const kind = new Uint8Array(length);
  const label = new Uint32Array(length);
  const spanStart = new Uint32Array(length);
  const spanEnd = new Uint32Array(length);
  const busy = new Float64Array(length);

  for (let k = 0; k < length; k++) {
    const a = startIdx[k] ?? 0;
    const b = endIdx[k] ?? 0;
    start[k] = samples.time[a] ?? 0;
    end[k] = (samples.time[b - 1] ?? 0) + (samples.dur[b - 1] ?? 0);
    let b2 = 0;
    for (let i = a; i < b; i++) {
      const leaf = tree.fn[samples.node[i] ?? 0] ?? 0;
      if ((functions.origin[leaf] ?? 0) !== Origin.Idle) b2 += samples.dur[i] ?? 0;
    }
    busy[k] = b2;
    spanStart[k] = lowerBound(spans.start, start[k] ?? 0);
    spanEnd[k] = lowerBound(spans.start, end[k] ?? 0);

    const entry = taskEntry[k] ?? 0;
    const entryName = nameOf(entry);
    const entryFile = fileOf(entry);
    // Module evaluation can run under a microtask (ESM), so look a few frames down as well.
    const isStartup = (sampleIndex: number, file: string): boolean => {
      if (MAIN_FILE_PREFIXES.some((p) => file.startsWith(p))) return true;
      let chain = 0;
      const stackTop: number[] = [];
      for (let n = samples.node[sampleIndex] ?? 0; n > 0; n = tree.parent[n] ?? 0) stackTop.push(n);
      stackTop.reverse();
      for (const n of stackTop) {
        if (chain++ >= 5) break;
        const f = fileOf(tree.fn[n] ?? 0);
        if (MAIN_FILE_PREFIXES.some((p) => f.startsWith(p))) return true;
      }
      return false;
    };
    let taskKind: TaskKindId = TaskKind.Other;
    if ((taskReq[k] ?? -1) >= 0) taskKind = TaskKind.Request;
    else if (TIMER_ENTRIES.has(entryName)) taskKind = TaskKind.Timer;
    else if (IMMEDIATE_ENTRIES.has(entryName)) taskKind = TaskKind.Immediate;
    else if (isStartup(a, entryFile)) taskKind = TaskKind.Main;
    else if (MICROTASK_ENTRIES.has(entryName)) taskKind = TaskKind.Microtask;
    else if (IO_ENTRIES.has(entryName)) taskKind = TaskKind.Io;
    kind[k] = taskKind;

    // First meaningful frame: the shallowest user frame that is not plumbing, else the shallowest
    // non-plumbing dependency frame, else the entry frame itself.
    let meaningful = -1;
    let fallback = -1;
    const scan = Math.min(b, a + 300);
    for (let i = a; i < scan && meaningful < 0; i++) {
      for (let n = samples.node[i] ?? 0; n > 0; n = tree.parent[n] ?? 0) {
        const fn = tree.fn[n] ?? 0;
        if ((functions.plumbing[fn] ?? 0) === 1) continue;
        const o = functions.origin[fn] ?? 0;
        if (o === Origin.User) meaningful = fn;
        else if (o === Origin.Dependency || o === Origin.Framework) fallback = fn;
      }
      if (meaningful < 0 && fallback >= 0 && i >= a + 20) break;
    }
    const subject = meaningful >= 0 ? meaningful : fallback >= 0 ? fallback : entry;
    // Entry kind prefix plus the first frame of the target's own code.
    const what = display(subject);
    const text =
      taskKind === TaskKind.Request
        ? `request · ${strings[requests.label[taskReq[k] ?? 0] ?? 0] ?? ''}`
        : taskKind === TaskKind.Main
          ? `main · ${MODULE_PREFIX.test(what) ? `load ${what.replace(MODULE_PREFIX, '')}` : what}`
          : `${KIND_PREFIX[taskKind] ?? 'other'} · ${what}`;
    label[k] = ctx.strings.intern(text);
  }

  return {
    table: {
      length,
      start,
      end,
      kind,
      label,
      spanStart,
      spanEnd,
      busy,
      // Filled in by the continuation pass.
      parentSpan: new Int32Array(length).fill(-1),
      resumeOf: new Int32Array(length).fill(-1),
      waitUs: new Float64Array(length),
      stitch: new Uint8Array(length),
      resumedFn: new Int32Array(length).fill(-1),
      runtimeOnly: new Uint8Array(length),
    },
    sampleStart: Uint32Array.from(startIdx),
    sampleEnd: Uint32Array.from(endIdx),
  };
}
