// Waterfall rows: spans rebuilt from the transformed view's samples, so the transform stack
// (merge plumbing, collapse dependencies, drop idle) decides what a row is.

import { Origin, TaskKind } from '../model.js';
import type { ExecutionModel, Samples } from '../model.js';
import { reconstructSpans } from '../passes/spans.js';
import { formatDuration, plural } from '../util/format.js';
import { DEFAULT_TRANSFORMS } from './types.js';
import type {
  RunWaterfallOptions,
  TransformedView,
  Waterfall,
  WaterfallOptions,
  WaterfallRow,
} from './types.js';
import { applyTransforms, withoutInversion } from './view.js';
import { lowerBound } from '../util/search.js';

const MAX_ASYNC_EDGES = 20;
const RUNTIME_BLIPS = new Set(['(program)', '(garbage collector)', '(idle)']);

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
      resumed: false,
      summaryTasks: [],
      summaryRuntimeUs: 0,
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

/** The view the rows are built from: call-order, with the requested origins hidden. */
function viewFor(
  model: ExecutionModel,
  view: TransformedView,
  options: WaterfallOptions,
): TransformedView {
  const base = withoutInversion(model, view);
  if (!options.hideOrigins || options.hideOrigins.length === 0) return base;
  return applyTransforms(model, base.trackIndex, [
    ...base.stack,
    { kind: 'hide-origins', origins: options.hideOrigins },
  ]);
}

/**
 * Applies the depth limit, minimum duration and sibling order. Rows whose parent was dropped are
 * dropped; ids are renumbered so `id` is always the index in the result.
 */
function shapeRows(
  rows: WaterfallRow[],
  criticalPath: number[],
  options: WaterfallOptions,
): { rows: WaterfallRow[]; criticalPath: number[] } {
  const sort = options.sort ?? 'time';
  const depthLimit = options.maxDepth;
  const minUs = options.minDurationUs ?? 0;
  if (depthLimit === undefined && minUs <= 0 && sort === 'time') return { rows, criticalPath };
  const keep = new Uint8Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const parentKept = r.parent < 0 || keep[r.parent] === 1;
    keep[i] =
      parentKept && (depthLimit === undefined || r.depth <= depthLimit) && r.durUs >= minUs ? 1 : 0;
  }
  let order: number[] = [];
  for (let i = 0; i < rows.length; i++) if (keep[i] === 1) order.push(i);
  if (sort !== 'time') {
    const kids = new Map<number, number[]>();
    for (const i of order) {
      const p = rows[i]?.parent ?? -1;
      const list = kids.get(p);
      if (list) list.push(i);
      else kids.set(p, [i]);
    }
    const byLength = (a: number, b: number): number =>
      (rows[b]?.durUs ?? 0) - (rows[a]?.durUs ?? 0) || a - b;
    const walk: number[] = [];
    const visit = (parent: number): void => {
      const list = kids.get(parent) ?? [];
      // Wait rows hang off the task, not off a call: keep them after the calls, in time order.
      const calls = list.filter((i) => rows[i]?.kind === 'call').sort(byLength);
      const waits = list.filter((i) => rows[i]?.kind !== 'call');
      for (const i of [...calls, ...waits]) {
        walk.push(i);
        visit(i);
      }
    };
    visit(-1);
    order = walk;
  }
  const newId = new Int32Array(rows.length).fill(-1);
  order.forEach((old, i) => {
    newId[old] = i;
  });
  const out = order.map((old, i): WaterfallRow => {
    const r = rows[old] as WaterfallRow;
    return { ...r, id: i, parent: r.parent < 0 ? -1 : (newId[r.parent] ?? -1) };
  });
  return {
    rows: out,
    criticalPath: criticalPath.map((id) => newId[id] ?? -1).filter((id) => id >= 0),
  };
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
        resumed: false,
        summaryTasks: [],
        summaryRuntimeUs: 0,
      });
      const sub = buildRows(model, view, origin, ts, te, target, rows.length, 2, waitId);
      // The critical path is the chain of the task itself, not of the tasks it scheduled.
      for (const r of sub.rows) rows.push({ ...r, critical: false });
      outEnd = Math.max(outEnd, te);
      hasAsyncFlow = true;
      used++;
    }
  }
  const buckets = options.minimapBuckets ?? 120;
  const shaped = shapeRows(rows, main.criticalPath, options);
  return {
    start,
    end: outEnd,
    precisionUs: model.meta.precisionUs,
    rows: shaped.rows,
    criticalPath: shaped.criticalPath,
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
    viewFor(model, view, options),
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
  return assemble(model, viewFor(model, view, options), start, end, -1, options);
}

// ---- Whole-run waterfall ----

/**
 * Busy time below which a task is small: the larger of 0.5 ms and 0.1% of the run, unless overridden (0 turns
 * collapsing off). Root-level `(program)`, GC and idle rows between tasks fold at the larger of this and two
 * sampling intervals.
 */
export function smallTaskLimitUs(
  model: ExecutionModel,
  trackIndex: number,
  override?: number,
): number {
  const track = model.tracks[trackIndex];
  return override ?? Math.max(500, 0.001 * (track?.durationUs ?? 0));
}

/** Tasks that are not worth a row: little busy time, or nothing of the program's in them. */
export function trivialTasks(
  model: ExecutionModel,
  trackIndex: number,
  thresholdUs?: number,
): Set<number> {
  const track = model.tracks[trackIndex];
  const out = new Set<number>();
  if (!track) return out;
  const tasks = track.tasks;
  const limit = smallTaskLimitUs(model, trackIndex, thresholdUs);
  if (limit <= 0) return out;
  let entry = -1;
  for (let k = 0; k < tasks.length && entry < 0; k++) {
    if (tasks.kind[k] === TaskKind.Main) entry = k;
  }
  for (let k = 0; k < tasks.length; k++) {
    if (k === entry) continue;
    if ((tasks.busy[k] ?? 0) < limit || tasks.runtimeOnly[k] === 1) out.add(k);
  }
  return out;
}

/**
 * Marks the heaviest child at each level, from the call roots down. Heaviest is the work in the subtree (self
 * time), not the wall extent: a call that merely waited across an await is wide but not on the critical path.
 */
function markCritical(rows: WaterfallRow[]): number[] {
  const kids = new Map<number, number[]>();
  for (const r of rows) {
    if (r.kind !== 'call') continue;
    const list = kids.get(r.parent);
    if (list) list.push(r.id);
    else kids.set(r.parent, [r.id]);
  }
  const work = new Float64Array(rows.length);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r || r.kind !== 'call') continue;
    work[i] = (work[i] ?? 0) + r.selfUs;
    if (r.parent >= 0) work[r.parent] = (work[r.parent] ?? 0) + (work[i] ?? 0);
  }
  const widest = (ids: number[] | undefined): number => {
    let best = -1;
    for (const id of ids ?? []) {
      if (best < 0 || (work[id] ?? 0) > (work[best] ?? 0)) best = id;
    }
    return best;
  };
  const path: number[] = [];
  for (let cur = widest(kids.get(-1)); cur >= 0; cur = widest(kids.get(cur))) {
    const row = rows[cur];
    if (row) row.critical = true;
    path.push(cur);
  }
  return path;
}

/**
 * Merges `alias`ed rows into their target, widens each row to cover its children, and emits the rows depth-first
 * (children in start order) with ids assigned last: a parent always comes before its children, and a child
 * is always one level below its parent, whatever the start times of merged rows.
 */
export function reindex(
  rows: WaterfallRow[],
  alias: Map<number, number>,
  drop: Set<number> = new Set(),
): WaterfallRow[] {
  const n = rows.length;
  const resolve = (id: number): number => {
    let cur = id;
    while (alias.has(cur)) cur = alias.get(cur) ?? cur;
    return cur;
  };
  // Ids are the rows' indexes until now.
  const live = new Uint8Array(n);
  for (let i = 0; i < n; i++) live[i] = alias.has(i) || drop.has(i) ? 0 : 1;
  const parent = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    if (!r || live[i] === 0 || r.parent < 0) continue;
    const p = resolve(r.parent);
    if (p !== i && live[p] === 1) parent[i] = p;
  }
  const start = Float64Array.from(rows, (r) => r.start);
  const end = Float64Array.from(rows, (r) => r.end);

  // A row covers its children: widen it, deepest first, when a merged child starts before it.
  const head = new Int32Array(n).fill(-1);
  const next = new Int32Array(n).fill(-1);
  const rootsList: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    if (live[i] === 0) continue;
    const p = parent[i] ?? -1;
    if (p < 0) rootsList.push(i);
    else {
      next[i] = head[p] ?? -1;
      head[p] = i;
    }
  }
  const topo: number[] = [];
  const stack = [...rootsList];
  while (stack.length > 0) {
    const cur = stack.pop() ?? 0;
    topo.push(cur);
    for (let c = head[cur] ?? -1; c >= 0; c = next[c] ?? -1) stack.push(c);
  }
  for (let i = topo.length - 1; i >= 0; i--) {
    const node = topo[i] ?? 0;
    const p = parent[node] ?? -1;
    if (p < 0) continue;
    if ((start[node] ?? 0) < (start[p] ?? 0)) start[p] = start[node] ?? 0;
    if ((end[node] ?? 0) > (end[p] ?? 0)) end[p] = end[node] ?? 0;
  }

  // Children in start order: one global sort, then each parent's list is filled in that order.
  const order = topo
    .slice()
    .sort(
      (x, y) =>
        (start[x] ?? 0) - (start[y] ?? 0) || (rows[x]?.depth ?? 0) - (rows[y]?.depth ?? 0) || x - y,
    );
  const first = new Int32Array(n).fill(-1);
  const last = new Int32Array(n).fill(-1);
  const sib = new Int32Array(n).fill(-1);
  const roots: number[] = [];
  for (const i of order) {
    const p = parent[i] ?? -1;
    if (p < 0) {
      roots.push(i);
      continue;
    }
    if ((last[p] ?? -1) < 0) first[p] = i;
    else sib[last[p] ?? 0] = i;
    last[p] = i;
  }

  const out: WaterfallRow[] = [];
  const newId = new Int32Array(n).fill(-1);
  const todo: Array<[number, number]> = [];
  for (let k = roots.length - 1; k >= 0; k--) todo.push([roots[k] ?? 0, -1]);
  while (todo.length > 0) {
    const [i, outParent] = todo.pop() ?? [0, -1];
    const r = rows[i] as WaterfallRow;
    const id = out.length;
    newId[i] = id;
    const depth = outParent < 0 ? r.depth : (out[outParent]?.depth ?? 0) + 1;
    out.push({
      ...r,
      id,
      parent: outParent,
      depth,
      start: start[i] ?? r.start,
      end: end[i] ?? r.end,
      durUs: (end[i] ?? r.end) - (start[i] ?? r.start),
    });
    const kids: number[] = [];
    for (let c = first[i] ?? -1; c >= 0; c = sib[c] ?? -1) kids.push(c);
    for (let k = kids.length - 1; k >= 0; k--) todo.push([kids[k] ?? 0, id]);
  }
  return out;
}

export function waterfallForRun(
  model: ExecutionModel,
  trackIndex: number,
  options: RunWaterfallOptions = {},
): Waterfall {
  const track = model.tracks[trackIndex];
  if (!track) {
    throw new Error(`No track at index ${trackIndex}; the model has ${model.tracks.length}.`);
  }
  const built = applyTransforms(model, trackIndex, options.transforms ?? DEFAULT_TRANSFORMS);
  const full = viewFor(model, built, options);
  const origin = extendedOrigin(model, full);
  const trivial = trivialTasks(model, trackIndex, options.collapseTrivialUs);

  // Samples of small tasks do not make rows; they come back as summary rows.
  const tasks = track.tasks;
  const keep: number[] = [];
  let k = 0;
  const all = full.samples;
  for (let i = 0; i < all.length; i++) {
    const t = all.time[i] ?? 0;
    while (k < tasks.length && (tasks.end[k] ?? 0) <= t) k++;
    const inTask = k < tasks.length && (tasks.start[k] ?? 0) <= t;
    if (!(inTask && trivial.has(k))) keep.push(i);
  }
  const view: TransformedView = {
    ...full,
    samples: {
      length: keep.length,
      time: Float64Array.from(keep, (i) => all.time[i] ?? 0),
      node: Uint32Array.from(keep, (i) => all.node[i] ?? 0),
      dur: Float64Array.from(keep, (i) => all.dur[i] ?? 0),
    },
  };
  // The run is the whole profile, small tasks included.
  const start = all.time[0] ?? 0;
  const lastAt = all.length - 1;
  const end = (all.time[lastAt] ?? 0) + (all.dur[lastAt] ?? 0);
  const main = buildRows(model, view, origin, start, Math.max(end, start + 1), -1, 0, 0, -1);
  let rows = main.rows;

  // One root row for the whole run: awaiting and small tasks leave gaps, not separate roots.
  const alias = new Map<number, number>();
  const rootRows = rows.filter((r) => r.kind === 'call' && r.parent < 0 && r.fn === track.rootFn);
  const root = rootRows[0];
  if (root) {
    for (const extra of rootRows.slice(1)) {
      alias.set(extra.id, root.id);
      root.start = Math.min(root.start, extra.start);
      root.end = Math.max(root.end, extra.end);
      root.selfUs += extra.selfUs;
    }
    root.start = Math.min(root.start, start);
    root.end = Math.max(root.end, end);
    root.durUs = root.end - root.start;
    root.share = 1;
    root.hatched = false;
  }

  // Root-level (program), GC and idle rows shorter than the limit sit between tasks (the stacks around them
  // share nothing, so they cannot be bridged into a call): noise, folded into the summary rows below.
  const taskLimit = smallTaskLimitUs(model, trackIndex, options.collapseTrivialUs);
  const blipLimit = taskLimit > 0 ? Math.max(taskLimit, 2 * model.meta.precisionUs) : 0;
  const topDepth = root ? 1 : 0;
  const drop = new Set<number>();
  const blips: Array<{ start: number; end: number; runtime: number }> = [];
  if (blipLimit > 0) {
    for (const r of rows) {
      if (r.kind !== 'call' || r.depth !== topDepth || r.fn < 0 || r.durUs >= blipLimit) continue;
      if (!RUNTIME_BLIPS.has(model.strings[model.functions.name[r.fn] ?? 0] ?? '')) continue;
      drop.add(r.id);
      blips.push({ start: r.start, end: r.end, runtime: r.durUs });
    }
  }

  // Segments after an await. The resumed call is another row, flagged, with an awaiting row before it.
  // Its callers are the same calls continuing: they stay one row each instead of repeating per segment.
  const tolerance = 2 * model.meta.precisionUs;
  const byFn = new Map<number, WaterfallRow[]>();
  for (const r of rows) {
    if (r.kind !== 'call' || r.depth === 0) continue;
    const list = byFn.get(r.fn);
    if (list) list.push(r);
    else byFn.set(r.fn, [r]);
  }
  const cont = track.continuations;
  const awaited = new Set<number>();
  const continuing = new Set<number>();
  const pendingWaits: Array<{ anchor: WaterfallRow; wait: number }> = [];
  for (let c = 0; c < cont.length; c++) {
    const at = track.spans.start[cont.span[c] ?? 0] ?? 0;
    const candidates = byFn.get(cont.fn[c] ?? 0) ?? [];
    const anchor = candidates.find((r) => Math.abs(r.start - at) <= tolerance);
    // A resumed call that begins inside a longer row of the same function still sits under its callers.
    const holder =
      anchor ??
      candidates
        .filter((r) => r.start - tolerance <= at && at <= r.end + tolerance)
        .reduce<WaterfallRow | undefined>(
          (best, r) => (!best || r.start > best.start ? r : best),
          undefined,
        );
    if (!holder) continue;
    for (let p = rows[holder.parent]; p && p.kind === 'call' && p.depth > 0; p = rows[p.parent]) {
      continuing.add(p.id);
    }
    if (!anchor) continue;
    // Kind 3 attaches a new call where the previous task yielded: not another segment of a call.
    const adopted = cont.stitch[c] === 3;
    if (!adopted) anchor.resumed = true;
    const source = cont.resumeOf[c] ?? -1;
    const wait = adopted
      ? (cont.waitUs[c] ?? 0)
      : source < 0
        ? 0
        : anchor.start - (track.spans.end[source] ?? anchor.start);
    if (awaited.has(anchor.id) || wait < model.meta.precisionUs) continue;
    awaited.add(anchor.id);
    pendingWaits.push({ anchor, wait });
  }
  // Merge a continuing caller into the earlier row of the same call under the same parent.
  const resolveAlias = (id: number): number => {
    let cur = id;
    while (alias.has(cur)) cur = alias.get(cur) ?? cur;
    return cur;
  };
  const latest = new Map<string, WaterfallRow>();
  for (const r of rows) {
    if (r.kind !== 'call' || r.depth === 0) continue;
    const key = `${r.node}:${resolveAlias(r.parent)}`;
    const prev = latest.get(key);
    // Touching rows (within a sampling interval) are one call cut by a sample of another stack.
    const touching = prev ? r.start - prev.end <= model.meta.precisionUs : false;
    if (prev && (touching || (continuing.has(r.id) && prev.end <= r.start + tolerance))) {
      alias.set(r.id, prev.id);
      prev.end = Math.max(prev.end, r.end);
      prev.durUs = prev.end - prev.start;
      prev.selfUs += r.selfUs;
      prev.share = prev.durUs / Math.max(1, end - start);
      prev.hatched = false;
    } else latest.set(key, r);
  }
  // An awaiting row hangs under the nearest caller row that was already running when the wait began.
  const waits: WaterfallRow[] = [];
  for (const { anchor, wait } of pendingWaits) {
    const began = anchor.start - wait;
    let holder: WaterfallRow = rows[resolveAlias(anchor.id)] ?? anchor;
    for (
      let p = rows[resolveAlias(holder.parent)];
      p && p.kind === 'call' && p.depth > 0 && p.start > began;
      p = rows[resolveAlias(holder.parent)]
    ) {
      holder = p;
    }
    waits.push({
      id: rows.length + waits.length,
      kind: 'wait',
      fn: -1,
      node: -1,
      start: began,
      end: anchor.start,
      durUs: wait,
      selfUs: wait,
      depth: holder.depth,
      parent: holder.parent,
      share: wait / Math.max(1, end - start),
      critical: false,
      hatched: false,
      task: -1,
      label: `awaiting ${formatDuration(wait)}`,
      resumed: false,
      summaryTasks: [],
      summaryRuntimeUs: 0,
    });
  }
  rows = [...rows, ...waits];

  // Small tasks and runtime blips: one summary row for each run of them between two real things.
  const rootId = root ? root.id : -1;
  const items: Array<{ start: number; end: number; busy: number; runtime: number; task: number }> =
    [
      ...[...trivial].map((k) => ({
        start: tasks.start[k] ?? 0,
        end: tasks.end[k] ?? 0,
        busy: tasks.busy[k] ?? 0,
        runtime: 0,
        task: k,
      })),
      ...blips.map((x) => ({ ...x, busy: 0, task: -1 })),
    ].sort((x, y) => x.start - y.start || x.end - y.end);
  const breakers: number[] = [];
  for (let k = 0; k < tasks.length; k++) if (!trivial.has(k)) breakers.push(tasks.start[k] ?? 0);
  for (const r of rows) {
    if (r.kind === 'call' && r.depth === topDepth && !alias.has(r.id) && !drop.has(r.id)) {
      breakers.push(r.start);
    }
  }
  breakers.sort((x, y) => x - y);
  const breakerBetween = (from: number, to: number): boolean => {
    let lo = 0;
    let hi = breakers.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((breakers[mid] ?? 0) <= from) lo = mid + 1;
      else hi = mid;
    }
    return lo < breakers.length && (breakers[lo] ?? 0) < to;
  };
  const summaries: WaterfallRow[] = [];
  for (let first = 0; first < items.length; first++) {
    let last = first;
    while (
      last + 1 < items.length &&
      !breakerBetween(items[last]?.start ?? 0, items[last + 1]?.start ?? 0)
    ) {
      last++;
    }
    const group = items.slice(first, last + 1);
    const list = group.filter((x) => x.task >= 0).map((x) => x.task);
    const busy = group.reduce((n, x) => n + x.busy, 0);
    const runtime = group.reduce((n, x) => n + x.runtime, 0);
    const s0 = Math.min(...group.map((x) => x.start));
    const e0 = Math.max(...group.map((x) => x.end));
    const total = busy + runtime;
    summaries.push({
      id: rows.length + summaries.length,
      kind: 'summary',
      fn: -1,
      node: -1,
      start: s0,
      end: e0,
      durUs: e0 - s0,
      selfUs: total,
      depth: topDepth,
      parent: rootId,
      share: total / Math.max(1, end - start),
      critical: false,
      hatched: false,
      task: -1,
      label:
        list.length > 0
          ? `${list.length} small ${plural(list.length, 'task', 'tasks')} · ${formatDuration(total)}`
          : `runtime pauses · ${formatDuration(total)}`,
      resumed: false,
      summaryTasks: list,
      summaryRuntimeUs: runtime,
    });
    first = last;
  }
  rows = reindex([...rows, ...summaries], alias, drop);
  for (const r of rows) r.critical = false;
  const path = markCritical(rows);
  const shaped = shapeRows(rows, path, options);
  return {
    start,
    end,
    precisionUs: model.meta.precisionUs,
    rows: shaped.rows,
    criticalPath: shaped.criticalPath,
    minimap: {
      start,
      end,
      busy: minimap(view, origin, start, Math.max(end, start + 1), options.minimapBuckets ?? 120),
    },
    hasAsyncFlow: false,
  };
}
