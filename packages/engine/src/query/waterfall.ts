// Waterfall rows: spans rebuilt from the transformed view's samples, so the transform stack
// (merge plumbing, collapse dependencies, drop idle) decides what a row is.

import { Origin, TaskKind } from '../model.js';
import { functionName } from '../frames.js';
import type { ExecutionModel, Samples, Track } from '../model.js';
import { reconstructSpans } from '../passes/spans.js';
import { formatDuration, plural } from '../util/format.js';
import { deoptCounts } from './deopts.js';
import { DEFAULT_TRANSFORMS } from './types.js';
import type {
  RunWaterfallOptions,
  TransformedView,
  Waterfall,
  WaterfallOptions,
  WaterfallRow,
} from './types.js';
import { applyTransforms, withoutInversion } from './view.js';
import { addCoverage, capAtOne } from '../util/buckets.js';
import { lowerBound } from '../util/search.js';
import { trackAt } from './track-at.js';

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

type RowFields = Pick<
  WaterfallRow,
  | 'id'
  | 'kind'
  | 'fn'
  | 'node'
  | 'start'
  | 'end'
  | 'durUs'
  | 'selfUs'
  | 'depth'
  | 'parent'
  | 'share'
  | 'task'
> &
  Partial<
    Pick<
      WaterfallRow,
      'critical' | 'hatched' | 'label' | 'resumed' | 'summaryTasks' | 'summaryRuntimeUs' | 'deopts'
    >
  >;

/** A row with the defaults every kind shares; the key order is part of the output. */
function makeRow(f: RowFields): WaterfallRow {
  return {
    id: f.id,
    kind: f.kind,
    fn: f.fn,
    node: f.node,
    start: f.start,
    end: f.end,
    durUs: f.durUs,
    selfUs: f.selfUs,
    depth: f.depth,
    parent: f.parent,
    share: f.share,
    critical: f.critical ?? false,
    hatched: f.hatched ?? false,
    task: f.task,
    label: f.label ?? '',
    resumed: f.resumed ?? false,
    summaryTasks: f.summaryTasks ?? [],
    summaryRuntimeUs: f.summaryRuntimeUs ?? 0,
    deopts: f.deopts ?? 0,
  };
}

/** Puts the deopt count of its function on every call row. */
function markDeopts(rows: WaterfallRow[], counts: Uint32Array): void {
  for (const r of rows) if (r.kind === 'call') r.deopts = counts[r.fn] ?? 0;
}

/** Follows merges to the row that survives. */
function resolveAlias(alias: Map<number, number>, id: number): number {
  let cur = id;
  while (alias.has(cur)) cur = alias.get(cur) ?? cur;
  return cur;
}

/** The time range the rows cover and the task they belong to (-1 for none). */
interface RowRange {
  start: number;
  end: number;
  task: number;
}

/** Where the rows go: their first id, the depth of their roots, and the row their roots hang under. */
interface RowPlace {
  rowBase: number;
  depthBase: number;
  parentOfRoots: number;
}

function buildRows(
  model: ExecutionModel,
  view: TransformedView,
  origin: Uint8Array,
  { start, end, task }: RowRange,
  { rowBase, depthBase, parentOfRoots }: RowPlace,
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
    rows.push(
      makeRow({
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
      }),
    );
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
    addCoverage(busy, a, Math.min(end, a + (samples.dur[i] ?? 0)), start, width);
  }
  capAtOne(busy);
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
  const main = buildRows(
    model,
    view,
    origin,
    { start, end, task },
    { rowBase: 0, depthBase: 0, parentOfRoots: -1 },
  );
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
      rows.push(
        makeRow({
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
          task: target,
          label: `idle wait ${formatDuration(waitUs)}`,
        }),
      );
      const sub = buildRows(
        model,
        view,
        origin,
        { start: ts, end: te, task: target },
        { rowBase: rows.length, depthBase: 2, parentOfRoots: waitId },
      );
      // The critical path is the chain of the task itself, not of the tasks it scheduled.
      for (const r of sub.rows) rows.push({ ...r, critical: false });
      outEnd = Math.max(outEnd, te);
      hasAsyncFlow = true;
      used++;
    }
  }
  const buckets = options.minimapBuckets ?? 120;
  const shaped = shapeRows(rows, main.criticalPath, options);
  markDeopts(shaped.rows, deoptCounts(model, view.trackIndex, view.syntheticPackages));
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
const PAGE_SMALL_TASK_US = 5000;
/** A group of small tasks on a page ends at an idle stretch this long, so a group is a burst, not seconds. */
const PAGE_GROUP_GAP_US = 100_000;

export function smallTaskLimitUs(
  model: ExecutionModel,
  trackIndex: number,
  override?: number,
): number {
  const track = model.tracks[trackIndex];
  if (override !== undefined) return override;
  // A page runs thousands of tasks of a fraction of a millisecond; listing them one by one buries the few that matter.
  if (model.target.kind === 'page') return PAGE_SMALL_TASK_US;
  return Math.max(500, 0.001 * (track?.durationUs ?? 0));
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
    if (tasks.kind[k] === TaskKind.Input) continue;
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
  // Ids are the rows' indexes until now.
  const live = new Uint8Array(n);
  for (let i = 0; i < n; i++) live[i] = alias.has(i) || drop.has(i) ? 0 : 1;
  const parent = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    if (!r || live[i] === 0 || r.parent < 0) continue;
    const p = resolveAlias(alias, r.parent);
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

/** The view without the samples of small tasks: those come back as summary rows. */
function withoutSmallTasks(
  full: TransformedView,
  track: Track,
  small: Set<number>,
): TransformedView {
  const tasks = track.tasks;
  const keep: number[] = [];
  let k = 0;
  const all = full.samples;
  for (let i = 0; i < all.length; i++) {
    const t = all.time[i] ?? 0;
    while (k < tasks.length && (tasks.end[k] ?? 0) <= t) k++;
    const inTask = k < tasks.length && (tasks.start[k] ?? 0) <= t;
    if (!(inTask && small.has(k))) keep.push(i);
  }
  return {
    ...full,
    samples: {
      length: keep.length,
      time: Float64Array.from(keep, (i) => all.time[i] ?? 0),
      node: Uint32Array.from(keep, (i) => all.node[i] ?? 0),
      dur: Float64Array.from(keep, (i) => all.dur[i] ?? 0),
    },
  };
}

/**
 * One root row for the whole run: awaiting and small tasks leave gaps, not separate roots. The extra roots
 * are merged into the first one (recorded in `alias`); returns it, if there is one.
 */
function mergeRootRows(
  rows: WaterfallRow[],
  rootFn: number,
  start: number,
  end: number,
  alias: Map<number, number>,
): WaterfallRow | undefined {
  const rootRows = rows.filter((r) => r.kind === 'call' && r.parent < 0 && r.fn === rootFn);
  const root = rootRows[0];
  if (!root) return undefined;
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
  return root;
}

interface Blip {
  start: number;
  end: number;
  runtime: number;
}

/**
 * Root-level (program), GC and idle rows shorter than the limit sit between tasks (the stacks around them
 * share nothing, so they cannot be bridged into a call): noise, dropped here and folded into the summary rows.
 */
function takeBlips(
  model: ExecutionModel,
  rows: WaterfallRow[],
  topDepth: number,
  blipLimit: number,
  drop: Set<number>,
): Blip[] {
  const blips: Blip[] = [];
  if (blipLimit <= 0) return blips;
  for (const r of rows) {
    if (r.kind !== 'call' || r.depth !== topDepth || r.fn < 0 || r.durUs >= blipLimit) continue;
    if (!RUNTIME_BLIPS.has(functionName(model, r.fn))) continue;
    drop.add(r.id);
    blips.push({ start: r.start, end: r.end, runtime: r.durUs });
  }
  return blips;
}

interface PendingWait {
  anchor: WaterfallRow;
  wait: number;
}

/**
 * Segments after an await. The resumed call is another row, flagged, with an awaiting row before it.
 * Its callers are the same calls continuing: they stay one row each instead of repeating per segment.
 */
function findResumedCalls(
  model: ExecutionModel,
  track: Track,
  rows: WaterfallRow[],
  tolerance: number,
): { continuing: Set<number>; pendingWaits: PendingWait[] } {
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
  const pendingWaits: PendingWait[] = [];
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
  return { continuing, pendingWaits };
}

/** Merges a continuing caller into the earlier row of the same call under the same parent. */
function mergeContinuingCalls(
  rows: WaterfallRow[],
  alias: Map<number, number>,
  continuing: Set<number>,
  precisionUs: number,
  span: number,
): void {
  const tolerance = 2 * precisionUs;
  const latest = new Map<string, WaterfallRow>();
  for (const r of rows) {
    if (r.kind !== 'call' || r.depth === 0) continue;
    const key = `${r.node}:${resolveAlias(alias, r.parent)}`;
    const prev = latest.get(key);
    // Touching rows (within a sampling interval) are one call cut by a sample of another stack.
    const touching = prev ? r.start - prev.end <= precisionUs : false;
    if (prev && (touching || (continuing.has(r.id) && prev.end <= r.start + tolerance))) {
      alias.set(r.id, prev.id);
      prev.end = Math.max(prev.end, r.end);
      prev.durUs = prev.end - prev.start;
      prev.selfUs += r.selfUs;
      prev.share = prev.durUs / span;
      prev.hatched = false;
    } else latest.set(key, r);
  }
}

/** An awaiting row hangs under the nearest caller row that was already running when the wait began. */
function awaitingRows(
  rows: WaterfallRow[],
  pendingWaits: PendingWait[],
  alias: Map<number, number>,
  span: number,
): WaterfallRow[] {
  const waits: WaterfallRow[] = [];
  for (const { anchor, wait } of pendingWaits) {
    const began = anchor.start - wait;
    let holder: WaterfallRow = rows[resolveAlias(alias, anchor.id)] ?? anchor;
    for (
      let p = rows[resolveAlias(alias, holder.parent)];
      p && p.kind === 'call' && p.depth > 0 && p.start > began;
      p = rows[resolveAlias(alias, holder.parent)]
    ) {
      holder = p;
    }
    waits.push(
      makeRow({
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
        share: wait / span,
        task: -1,
        label: `awaiting ${formatDuration(wait)}`,
      }),
    );
  }
  return waits;
}

/** What the run's rows folded away, and where the top-level rows sit. */
interface Folds {
  alias: Map<number, number>;
  drop: Set<number>;
  topDepth: number;
  rootId: number;
}

/** Small tasks and runtime blips: one summary row for each run of them between two real things. */
function summaryRows(
  rows: WaterfallRow[],
  track: Track,
  folded: { small: Set<number>; blips: Blip[] },
  { alias, drop, topDepth, rootId }: Folds,
  span: number,
  gap: { maxUs: number; pauses: Array<[number, number]> },
): WaterfallRow[] {
  const { small, blips } = folded;
  const tasks = track.tasks;
  const items: Array<{ start: number; end: number; busy: number; runtime: number; task: number }> =
    [
      ...[...small].map((k) => ({
        start: tasks.start[k] ?? 0,
        end: tasks.end[k] ?? 0,
        busy: tasks.busy[k] ?? 0,
        runtime: 0,
        task: k,
      })),
      ...blips.map((x) => ({ ...x, busy: 0, task: -1 })),
    ].sort((x, y) => x.start - y.start || x.end - y.end);
  const breakers: number[] = [];
  for (let k = 0; k < tasks.length; k++) if (!small.has(k)) breakers.push(tasks.start[k] ?? 0);
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
  const apart = (a: number, b: number): boolean => {
    if (b - a > gap.maxUs) return true;
    return gap.pauses.some(([from, to]) => a < to && b > from);
  };
  const summaries: WaterfallRow[] = [];
  for (let first = 0; first < items.length; first++) {
    let last = first;
    let reach = items[first]?.end ?? 0;
    while (
      last + 1 < items.length &&
      !breakerBetween(items[last]?.start ?? 0, items[last + 1]?.start ?? 0) &&
      !apart(reach, items[last + 1]?.start ?? 0)
    ) {
      last++;
      reach = Math.max(reach, items[last]?.end ?? 0);
    }
    const group = items.slice(first, last + 1);
    const list = group.filter((x) => x.task >= 0).map((x) => x.task);
    const busy = group.reduce((n, x) => n + x.busy, 0);
    const runtime = group.reduce((n, x) => n + x.runtime, 0);
    const s0 = Math.min(...group.map((x) => x.start));
    const e0 = Math.max(...group.map((x) => x.end));
    const total = busy + runtime;
    summaries.push(
      makeRow({
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
        share: total / span,
        task: -1,
        label:
          list.length > 0
            ? `${list.length} small ${plural(list.length, 'task', 'tasks')} · ${formatDuration(total)}`
            : `runtime pauses · ${formatDuration(total)}`,
        summaryTasks: list,
        summaryRuntimeUs: runtime,
      }),
    );
    first = last;
  }
  return summaries;
}

function pageGaps(model: ExecutionModel): { maxUs: number; pauses: Array<[number, number]> } {
  if (model.target.kind !== 'page') return { maxUs: Infinity, pauses: [] };
  const paused = model.page?.paused;
  const pauses: Array<[number, number]> = [];
  for (let k = 0; k < (paused?.length ?? 0); k++) {
    pauses.push([paused?.start[k] ?? 0, paused?.end[k] ?? 0]);
  }
  return { maxUs: PAGE_GROUP_GAP_US, pauses };
}

export function waterfallForRun(
  model: ExecutionModel,
  trackIndex: number,
  options: RunWaterfallOptions = {},
): Waterfall {
  const track = trackAt(model, trackIndex);
  const built = applyTransforms(model, trackIndex, options.transforms ?? DEFAULT_TRANSFORMS);
  const full = viewFor(model, built, options);
  const origin = extendedOrigin(model, full);
  const small = trivialTasks(model, trackIndex, options.collapseTrivialUs);
  const view = withoutSmallTasks(full, track, small);

  // The run is the whole profile, small tasks included.
  const all = full.samples;
  const start = all.time[0] ?? 0;
  const lastAt = all.length - 1;
  const end = (all.time[lastAt] ?? 0) + (all.dur[lastAt] ?? 0);
  const span = Math.max(1, end - start);
  const main = buildRows(
    model,
    view,
    origin,
    { start, end: Math.max(end, start + 1), task: -1 },
    { rowBase: 0, depthBase: 0, parentOfRoots: -1 },
  );

  const alias = new Map<number, number>();
  const root = mergeRootRows(main.rows, track.rootFn, start, end, alias);
  const taskLimit = smallTaskLimitUs(model, trackIndex, options.collapseTrivialUs);
  const blipLimit = taskLimit > 0 ? Math.max(taskLimit, 2 * model.meta.precisionUs) : 0;
  const topDepth = root ? 1 : 0;
  const drop = new Set<number>();
  const blips = takeBlips(model, main.rows, topDepth, blipLimit, drop);

  const { continuing, pendingWaits } = findResumedCalls(
    model,
    track,
    main.rows,
    2 * model.meta.precisionUs,
  );
  mergeContinuingCalls(main.rows, alias, continuing, model.meta.precisionUs, span);
  const rows = [...main.rows, ...awaitingRows(main.rows, pendingWaits, alias, span)];
  const summaries = summaryRows(
    rows,
    track,
    { small, blips },
    { alias, drop, topDepth, rootId: root ? root.id : -1 },
    span,
    pageGaps(model),
  );

  const ordered = reindex([...rows, ...summaries], alias, drop);
  for (const r of ordered) r.critical = false;
  const path = markCritical(ordered);
  const shaped = shapeRows(ordered, path, options);
  markDeopts(shaped.rows, deoptCounts(model, trackIndex, view.syntheticPackages));
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
