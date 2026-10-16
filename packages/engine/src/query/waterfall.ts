// Waterfall rows: spans rebuilt from the transformed view's samples, so the transform stack
// (merge plumbing, collapse dependencies, drop idle) decides what a row is.

import { Origin } from '../model.js';
import type { ExecutionModel, Samples } from '../model.js';
import { reconstructSpans } from '../passes/spans.js';
import { formatDuration } from '../util/format.js';
import type { TransformedView, Waterfall, WaterfallOptions, WaterfallRow } from './types.js';
import { withoutInversion } from './view.js';

const MAX_ASYNC_EDGES = 20;

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

function extendedOrigin(model: ExecutionModel, view: TransformedView): Uint8Array {
  const F = model.functions.length;
  const origin = new Uint8Array(F + view.syntheticPackages.length);
  origin.set(model.functions.origin);
  origin.fill(Origin.Dependency, F);
  return origin;
}

function sliceSamples(view: TransformedView, start: number, end: number): Samples {
  const a = lowerBound(view.samples.time, start);
  const b = lowerBound(view.samples.time, end);
  return {
    length: Math.max(0, b - a),
    time: view.samples.time.subarray(a, b),
    node: view.samples.node.subarray(a, b),
    dur: view.samples.dur.subarray(a, b),
  };
}

interface Built {
  rows: WaterfallRow[];
  criticalPath: number[];
}

function buildRows(
  model: ExecutionModel,
  view: TransformedView,
  origin: Uint8Array,
  start: number,
  end: number,
  task: number,
  rowBase: number,
  depthBase: number,
  parentOfRoots: number,
): Built {
  const samples = sliceSamples(view, start, end);
  const spans = reconstructSpans({
    tree: view.tree,
    samples,
    origin,
    gapUs: model.meta.precisionUs * 3,
  });
  const span = Math.max(1, end - start);
  const n = spans.length;
  const children: number[][] = Array.from({ length: n }, () => []);
  const roots: number[] = [];
  const covered = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = spans.parent[i] ?? -1;
    const dur = (spans.end[i] ?? 0) - (spans.start[i] ?? 0);
    if (p < 0) roots.push(i);
    else {
      children[p]?.push(i);
      covered[p] = (covered[p] ?? 0) + dur;
    }
  }
  const critical = new Uint8Array(n);
  const path: number[] = [];
  const widest = (ids: number[]): number => {
    let best = -1;
    let bestDur = -1;
    for (const i of ids) {
      const d = (spans.end[i] ?? 0) - (spans.start[i] ?? 0);
      if (d > bestDur) {
        bestDur = d;
        best = i;
      }
    }
    return best;
  };
  for (let cur = widest(roots); cur >= 0; cur = widest(children[cur] ?? [])) {
    critical[cur] = 1;
    path.push(rowBase + cur);
  }
  const rows: WaterfallRow[] = [];
  for (let i = 0; i < n; i++) {
    const dur = (spans.end[i] ?? 0) - (spans.start[i] ?? 0);
    const p = spans.parent[i] ?? -1;
    rows.push({
      id: rowBase + i,
      kind: 'call',
      fn: spans.fn[i] ?? 0,
      node: spans.node[i] ?? 0,
      start: spans.start[i] ?? 0,
      end: spans.end[i] ?? 0,
      durUs: dur,
      selfUs: Math.max(0, dur - (covered[i] ?? 0)),
      depth: depthBase + (spans.depth[i] ?? 0),
      parent: p < 0 ? parentOfRoots : rowBase + p,
      share: dur / span,
      critical: critical[i] === 1,
      hatched: dur < 2 * model.meta.precisionUs,
      task,
      label: '',
    });
  }
  return { rows, criticalPath: path };
}

function minimap(
  view: TransformedView,
  origin: Uint8Array,
  start: number,
  end: number,
  buckets: number,
): Float32Array {
  const busy = new Float32Array(buckets);
  const width = Math.max(1e-9, (end - start) / buckets);
  const samples = sliceSamples(view, start, end);
  for (let i = 0; i < samples.length; i++) {
    const leaf = view.tree.fn[samples.node[i] ?? 0] ?? 0;
    if ((origin[leaf] ?? 0) === Origin.Idle) continue;
    const a = samples.time[i] ?? 0;
    const b = Math.min(end, a + (samples.dur[i] ?? 0));
    for (let k = Math.max(0, Math.floor((a - start) / width)); k < buckets; k++) {
      const lo = start + k * width;
      if (lo >= b) break;
      const overlap = Math.min(b, lo + width) - Math.max(a, lo);
      if (overlap > 0) busy[k] = (busy[k] ?? 0) + overlap / width;
    }
  }
  for (let k = 0; k < buckets; k++) busy[k] = Math.min(1, busy[k] ?? 0);
  return busy;
}

function assemble(
  model: ExecutionModel,
  view: TransformedView,
  start: number,
  end: number,
  task: number,
  options: WaterfallOptions,
): Waterfall {
  const origin = extendedOrigin(model, view);
  const main = buildRows(model, view, origin, start, end, task, 0, 0, -1);
  const rows = main.rows;
  let outEnd = end;
  let hasAsyncFlow = false;
  const track = model.tracks[view.trackIndex];
  if (task >= 0 && track && options.followAsync !== false) {
    const edges = track.asyncEdges;
    let used = 0;
    for (let e = 0; e < edges.length && used < MAX_ASYNC_EDGES; e++) {
      if (edges.from[e] !== task) continue;
      const target = edges.to[e] ?? 0;
      const ts = track.tasks.start[target] ?? 0;
      const te = track.tasks.end[target] ?? 0;
      const waitStart = end;
      const waitId = rows.length;
      const waitUs = edges.waitUs[e] ?? 0;
      rows.push({
        id: waitId,
        kind: 'wait',
        fn: -1,
        node: -1,
        start: waitStart,
        end: waitStart + waitUs,
        durUs: waitUs,
        selfUs: waitUs,
        depth: 1,
        parent: -1,
        share: waitUs / Math.max(1, end - start),
        critical: false,
        hatched: false,
        task: target,
        label: `idle wait ${formatDuration(waitUs)}`,
      });
      const sub = buildRows(model, view, origin, ts, te, target, rows.length, 1, waitId);
      for (const r of sub.rows) rows.push(r);
      outEnd = Math.max(outEnd, te);
      hasAsyncFlow = true;
      used++;
    }
  }
  const buckets = options.minimapBuckets ?? 120;
  const depthLimit = options.maxDepth;
  const kept = depthLimit === undefined ? rows : rows.filter((r) => r.depth <= depthLimit);
  return {
    start,
    end: outEnd,
    precisionUs: model.meta.precisionUs,
    rows: kept,
    criticalPath: main.criticalPath,
    minimap: { start, end, busy: minimap(view, origin, start, end, buckets) },
    hasAsyncFlow,
  };
}

export function waterfallForTask(
  model: ExecutionModel,
  view: TransformedView,
  task: number,
  options: WaterfallOptions = {},
): Waterfall {
  const track = model.tracks[view.trackIndex];
  if (!track || task < 0 || task >= track.tasks.length) {
    throw new Error(`No task ${task} in track ${view.trackIndex}.`);
  }
  return assemble(
    model,
    withoutInversion(model, view),
    track.tasks.start[task] ?? 0,
    track.tasks.end[task] ?? 0,
    task,
    options,
  );
}

export function waterfallForRange(
  model: ExecutionModel,
  view: TransformedView,
  start: number,
  end: number,
  options: WaterfallOptions = {},
): Waterfall {
  return assemble(model, withoutInversion(model, view), start, end, -1, options);
}
