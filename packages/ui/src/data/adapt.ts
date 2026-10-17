import {
  Origin,
  callGraph,
  childrenOf,
  describeTasks,
  findNode,
  hotPaths,
  flameLayout,
  functionRows,
  functionSource,
  nodePath,
  sandwich,
  timelineLane,
  waterfallForRange,
  waterfallForRun,
  waterfallForTask,
} from '@pacesjs/engine';
import type { ExecutionModel, FlameLayout, ModelDiff, OriginId, Track } from '@pacesjs/engine';
import { fileLine, locationOf, trackOrder } from './scope';
import type { Scoped } from './scope';
import type {
  CallGraphData,
  CallNumbers,
  CgEdge,
  CgNode,
  Details,
  FlameData,
  FlameOptions,
  FileOutline,
  FnRow,
  HiddenOrigin,
  HotPathRow,
  FunctionsResult,
  LaneData,
  RelatedRow,
  SandwichRow,
  SourceInfo,
  TaskOption,
  WaterfallData,
  WaterfallRow,
} from './types';

const MIN_FRAME_FRACTION = 0.0002;
const SANDWICH_CALLER_LEVELS = 3;
const SANDWICH_CALLEE_LEVELS = 2;
const MIN_SANDWICH_WIDTH = 0.004;

export const taskLabelOf = (model: ExecutionModel, track: Track, i: number): string =>
  model.strings[track.tasks.label[i] ?? 0] || 'task';

/** The task picker's rows: grouped by what started them, the entry point first. */
export function taskOptions(model: ExecutionModel, trackIndex: number): TaskOption[] {
  return describeTasks(model, trackIndex).map((d) => ({
    index: d.index,
    group: d.group,
    label: d.label,
    startUs: d.startUs,
    durationUs: d.durationUs,
    busyUs: d.busyUs,
    trivial: d.trivial,
    longest: d.longest,
  }));
}

// ---- Waterfall ----

export interface WaterfallRequest {
  /** Task index; -1 means the longest task, or the range when one is given. */
  task: number;
  range: readonly [number, number] | null;
  /** Sibling order and the shortest call to keep: the engine applies both. */
  sort: 'time' | 'duration' | 'share';
  minDurUs: number;
}

/**
 * Engine waterfall rows with the task itself as row 0 (the engine's first row is the first frame
 * of the task), every other row one level deeper. Wait rows hang off the task row.
 */
export function waterfallData(
  model: ExecutionModel,
  s: Scoped,
  req: WaterfallRequest,
): WaterfallData | null {
  const { track } = s;
  // -1 (auto) is a presentation fold done in the UI, so the engine keeps every row.
  const opts = { sort: req.sort, minDurationUs: Math.max(0, req.minDurUs) };
  const mode: WaterfallData['mode'] =
    req.task >= 0 && req.task < track.tasks.length ? 'task' : req.range ? 'range' : 'run';

  if (mode === 'run') {
    // The default: the whole logical execution from the entry script, continuations stitched.
    const wf = waterfallForRun(model, s.trackIndex, { ...opts, transforms: s.view.stack });
    const t0 = wf.start;
    const rows: WaterfallRow[] = wf.rows.map((r) => {
      const fn = r.kind === 'call' ? s.out(r.fn) : -1;
      const info = fn >= 0 ? s.info(fn) : null;
      return {
        id: r.id,
        kind: r.kind,
        fn,
        path: r.kind === 'call' ? nodePath(s.view.tree, r.node).map((f) => s.out(f)) : [],
        name: info ? info.name || '(anonymous)' : r.label,
        loc: info ? locationOf(info) : '',
        origin: info ? info.origin : Origin.Idle,
        start: r.start - t0,
        end: r.end - t0,
        depth: r.depth,
        parent: r.parent,
        hasChildren: false,
        critical: r.critical,
        belowPrecision: r.hatched,
        share: r.share,
        resumed: r.resumed,
        summaryTasks: r.summaryTasks,
        selfUs: r.selfUs,
      };
    });
    for (const r of rows) if (r.parent >= 0) (rows[r.parent] as WaterfallRow).hasChildren = true;
    return {
      mode,
      taskIndex: -1,
      trackId: track.id,
      taskLabel: describeTasks(model, s.trackIndex)[0]?.label ?? 'Whole run',
      taskUs: Math.max(1, wf.end - wf.start),
      taskStartUs: t0,
      rows,
      criticalRows: wf.criticalPath,
      hasAsync: wf.hasAsyncFlow,
    };
  }

  const task = mode === 'task' ? req.task : -1;
  const wf =
    mode === 'range' && req.range
      ? waterfallForRange(model, s.view, req.range[0], req.range[1], opts)
      : waterfallForTask(model, s.view, task, opts);
  const t0 = wf.start;
  const spanUs = Math.max(1, wf.end - wf.start);
  const label =
    mode === 'range' && req.range
      ? `Range ${(req.range[0] / 1e6).toFixed(1)}–${(req.range[1] / 1e6).toFixed(1)} s`
      : (describeTasks(model, s.trackIndex).find((d) => d.index === task)?.label ??
        taskLabelOf(model, track, task));
  const rows: WaterfallRow[] = [
    {
      id: 0,
      kind: 'task',
      fn: -1,
      path: [],
      name: label,
      loc: '',
      origin: Origin.Node,
      start: 0,
      end: spanUs,
      depth: 0,
      parent: -1,
      hasChildren: wf.rows.length > 0,
      critical: wf.rows.length > 0,
      belowPrecision: false,
      share: 1,
      resumed: false,
      summaryTasks: [],
      selfUs: 0,
    },
  ];
  for (const r of wf.rows) {
    const call = r.kind === 'call';
    const info = call ? s.info(s.out(r.fn)) : null;
    rows.push({
      id: r.id + 1,
      kind: r.kind,
      fn: call ? s.out(r.fn) : -1,
      path: call ? nodePath(s.view.tree, r.node).map((f) => s.out(f)) : [],
      name: info ? info.name || '(anonymous)' : r.label,
      loc: info ? locationOf(info) : '',
      origin: info ? info.origin : Origin.Idle,
      start: r.start - t0,
      end: r.end - t0,
      depth: r.depth + 1,
      parent: r.parent < 0 ? 0 : r.parent + 1,
      hasChildren: false,
      critical: r.critical,
      belowPrecision: r.hatched,
      share: r.share,
      resumed: r.resumed,
      summaryTasks: r.summaryTasks,
      selfUs: r.selfUs,
    });
  }
  for (const r of rows) if (r.parent >= 0) (rows[r.parent] as WaterfallRow).hasChildren = true;
  return {
    mode,
    taskIndex: task,
    trackId: track.id,
    taskLabel: label,
    taskUs: spanUs,
    taskStartUs: t0,
    rows,
    criticalRows: [0, ...wf.criticalPath.map((id) => id + 1)],
    hasAsync: wf.hasAsyncFlow,
  };
}

// ---- Flame graph ----

/**
 * The view node a chain of function ids leads to: the longest prefix that exists in this view
 * (collapsed packages and merged plumbing can remove frames of a hot path). 0 when none does.
 */
function zoomNodeOfPath(s: Scoped, fns: readonly number[]): number {
  const tree = s.view.tree;
  // A stitched view is rooted at the entry script's function, which hot paths do not include.
  const entry = tree.length > 1 && tree.parent[1] === 0 ? [tree.fn[1] ?? 0] : [];
  let best = 0;
  for (const lead of [[], entry]) {
    for (let n = fns.length; n > 0; n--) {
      const path = [...lead, ...fns.slice(0, n).map((f) => s.inn(f))];
      if (path.every((f) => f >= 0)) {
        const node = findNode(tree, path);
        if (node > 0) {
          if ((tree.depth[node] ?? 0) > (tree.depth[best] ?? 0)) best = node;
          break;
        }
      }
    }
  }
  if (best > 0 && (tree.depth[best] ?? 0) >= fns.length) return best;
  // A chain from the engine can begin below the root of this view: a stitched run hangs a
  // continuation under whatever the previous task was inside (a dependency frame the hot path
  // skips). Look for it anywhere, taking the longest match.
  const inner = fns.map((f) => s.inn(f));
  if (inner.some((f) => f < 0)) return best;
  const kids = new Map<number, number[]>();
  for (let n = 1; n < tree.length; n++) {
    const p = tree.parent[n] ?? 0;
    const list = kids.get(p);
    if (list) list.push(n);
    else kids.set(p, [n]);
  }
  let bestLen = best > 0 ? (tree.depth[best] ?? 0) : 0;
  for (let start = 1; start < tree.length; start++) {
    if (tree.fn[start] !== inner[0]) continue;
    let node = start;
    let len = 1;
    while (len < inner.length) {
      // The nearest descendant: dependency frames between two of your own are skipped.
      let next: number | undefined;
      for (let level = kids.get(node) ?? []; level.length > 0 && next === undefined;) {
        next = level.find((c) => tree.fn[c] === inner[len]);
        level = level.flatMap((c) => kids.get(c) ?? []);
      }
      if (next === undefined) break;
      node = next;
      len++;
    }
    if (len > bestLen) {
      bestLen = len;
      best = node;
    }
  }
  return best;
}

export function flameData(
  model: ExecutionModel,
  s: Scoped,
  opts: FlameOptions,
  diff: ModelDiff | null,
): FlameData {
  const pathNode = opts.zoomPath.length > 0 ? zoomNodeOfPath(s, opts.zoomPath) : 0;
  const zoomLast =
    pathNode > 0
      ? pathNode
      : opts.zoom.length > 0
        ? (opts.zoom[opts.zoom.length - 1] as number)
        : 0;
  const layout: FlameLayout = flameLayout(model, s.view, {
    sort: opts.sort === 'alpha' ? 'alphabetical' : 'left-heavy',
    colorBy: diff ? 'diff' : opts.color,
    diff: diff ?? undefined,
    zoomNode: zoomLast > 0 && zoomLast < s.view.tree.length ? zoomLast : undefined,
    minWidth: MIN_FRAME_FRACTION,
  });
  const n = layout.length;
  const node = new Int32Array(n);
  const fn = new Uint32Array(n);
  const heat = new Float32Array(n);
  const delta = diff ? new Float32Array(n) : undefined;
  const names: string[] = [];
  const locs: string[] = [];
  const zoomed = layout.zoomPath.length > 1;
  for (let i = 0; i < n; i++) {
    const engineNode = layout.node[i] ?? 0;
    const isRoot = engineNode === 0 && !zoomed;
    node[i] = isRoot ? -1 : engineNode;
    fn[i] = s.out(layout.fn[i] ?? 0);
    if (isRoot) {
      names.push('all samples');
      locs.push('');
    } else {
      const info = s.info(fn[i] ?? 0);
      names.push(info.name || '(anonymous)');
      locs.push(info.synthetic ? '' : locationOf(info));
    }
    if (!diff) heat[i] = layout.intensity[i] ?? 0;
    else if (delta) {
      const change = layout.change[i] ?? 0;
      const mag = layout.intensity[i] ?? 0;
      delta[i] = change === -1 ? -mag : change === 0 ? 0 : mag || 0.5;
    }
  }
  const crumbs = layout.zoomPath.slice(1).map((nd) => ({
    node: nd,
    name: s.info(s.out(s.view.tree.fn[nd] ?? 0)).name,
  }));
  return {
    length: n,
    node,
    depth: layout.depth,
    x: layout.x,
    w: layout.w,
    fn,
    origin: layout.origin,
    heat,
    totalUs: layout.total,
    selfUs: layout.self,
    delta,
    names,
    locs,
    rootUs: layout.totalUs,
    maxDepth: layout.maxDepth,
    crumbs,
  };
}

// ---- Functions table, details, sandwich ----

/** Share is relative to the wall time of the track (or range), as the column promises. */
function baseTimeUs(s: Scoped, range: readonly [number, number] | null): number {
  return Math.max(1, range ? range[1] - range[0] : s.track.durationUs);
}

export interface FunctionFilter {
  /** Keep only functions of these origins. */
  origins?: number[];
  /** Keep only functions of this package (its collapsed row included). */
  pkg?: string;
}

export function functionsTable(
  model: ExecutionModel,
  s: Scoped,
  range: readonly [number, number] | null,
  filter: string,
  scope: FunctionFilter = {},
): FunctionsResult {
  const base = baseTimeUs(s, range);
  const q = filter.trim();
  const toRow = (r: ReturnType<typeof functionRows>[number]): FnRow => {
    const fn = s.out(r.fn);
    const info = s.info(fn);
    return {
      fn,
      name: r.name || '(anonymous)',
      origin: r.origin,
      pkg: r.pkg,
      selfUs: r.self,
      totalUs: r.total,
      share: r.self / base,
      calls: r.calls,
      loc: locationOf(info),
    };
  };
  const narrow = {
    ...(scope.origins ? { origins: scope.origins as OriginId[] } : {}),
    ...(scope.pkg ? { pkg: scope.pkg } : {}),
  };
  const all = functionRows(model, s.view, narrow);
  const rows = q ? functionRows(model, s.view, { ...narrow, search: q }) : all;
  return { rows: rows.map(toRow), totalFns: all.length, baseUs: base };
}

/**
 * The functions `fn` calls directly, with their time under it, from the engine's callee tree.
 * That tree merges the calls once, so the time of one callee never counts a recursive re-entry
 * twice and can never be more than the function's own total.
 */
function calleesOf(
  model: ExecutionModel,
  s: Scoped,
  engineFn: number,
): Array<{ fn: number; selfUs: number; totalUs: number }> {
  const sw = sandwich(model, s.view, engineFn);
  const out: Array<{ fn: number; selfUs: number; totalUs: number }> = [];
  for (let i = 0; i < sw.callees.length; i++) {
    if (sw.callees.depth[i] !== 2) continue;
    out.push({
      fn: sw.callees.fn[i] ?? 0,
      selfUs: sw.callees.self[i] ?? 0,
      totalUs: sw.callees.total[i] ?? 0,
    });
  }
  return out.sort((a, b) => b.totalUs - a.totalUs || a.fn - b.fn);
}

/** The call node at `path` (UI ids from the root): its CPU time, self time and direct callees. */
export function callAt(s: Scoped, path: readonly number[]): CallNumbers | null {
  const ids = path.map((f) => s.inn(f));
  if (path.length === 0 || ids.some((f) => f < 0)) return null;
  const tree = s.view.tree;
  const node = findNode(tree, ids);
  if (node <= 0) return null;
  const byFn = new Map<number, number>();
  for (const c of childrenOf(tree, node)) {
    const f = tree.fn[c] ?? 0;
    byFn.set(f, (byFn.get(f) ?? 0) + (tree.total[c] ?? 0));
  }
  const callees = [...byFn.entries()]
    .map(([f, totalUs]) => {
      const fn = s.out(f);
      const info = s.info(fn);
      return { fn, name: info.name || '(anonymous)', origin: info.origin, totalUs };
    })
    .sort((a, b) => b.totalUs - a.totalUs || a.fn - b.fn);
  return { totalUs: tree.total[node] ?? 0, selfUs: tree.self[node] ?? 0, callees };
}

export function functionDetails(
  model: ExecutionModel,
  s: Scoped,
  range: readonly [number, number] | null,
  fn: number,
): Details | null {
  const engineFn = s.inn(fn);
  if (engineFn < 0) return null;
  const row = functionRows(model, s.view, { includeIdle: true }).find((r) => r.fn === engineFn);
  if (!row) return null;
  const info = s.info(fn);
  const src = functionSource(model, s.view, engineFn);
  const sw = sandwich(model, s.view, engineFn);
  const denom = src.totalUs || 1;

  const callerRows: RelatedRow[] = [];
  let seen = 0;
  for (let i = 0; i < sw.callers.length; i++) {
    if (sw.callers.depth[i] !== 2) continue;
    const f = s.out(sw.callers.fn[i] ?? 0);
    const frac = sw.callers.total[i] ? (sw.callers.total[i] ?? 0) / denom : 0;
    seen += frac;
    callerRows.push({
      fn: f,
      name: s.info(f).name,
      origin: s.info(f).origin,
      frac,
      kind: 'caller',
    });
  }
  callerRows.sort((a, b) => b.frac - a.frac || a.name.localeCompare(b.name));
  if (seen < 0.995)
    callerRows.push({
      fn: null,
      name: '(root)',
      origin: Origin.Native,
      frac: 1 - seen,
      kind: 'caller',
    });

  const calleeRows: RelatedRow[] = calleesOf(model, s, engineFn)
    .slice(0, 6)
    .map((c) => {
      const f = s.out(c.fn);
      return {
        fn: f,
        name: s.info(f).name,
        origin: s.info(f).origin,
        frac: c.totalUs / denom,
        kind: 'callee',
      };
    });
  calleeRows.push({ fn: null, name: 'self', origin: -1, frac: row.self / denom, kind: 'self' });
  calleeRows.sort((a, b) => b.frac - a.frac);

  const base = baseTimeUs(s, range);
  return {
    fn,
    name: info.name || '(anonymous)',
    loc: locationOf(info),
    origin: info.origin,
    pkg: info.pkg,
    totalUs: row.total,
    selfUs: row.self,
    share: row.total / base,
    calls: row.calls,
    callers: callerRows.slice(0, 6),
    callees: calleeRows,
  };
}

/** Callers inverted above (engine `sandwich().callers`), callees below, as fractions of the function. */
export function sandwichRows(model: ExecutionModel, s: Scoped, fn: number): SandwichRow[] {
  const engineFn = s.inn(fn);
  if (engineFn < 0) return [];
  const sw = sandwich(model, s.view, engineFn);
  const total = sw.callees.total[1] ?? 0;
  if (total <= 0) return [];
  const rows: SandwichRow[] = [];
  const push = (layout: FlameLayout, i: number, level: number, isSelf = false): void => {
    const f = s.out(layout.fn[i] ?? 0);
    const x = layout.x[i] ?? 0;
    rows.push({
      level,
      name: s.info(f).name,
      origin: s.info(f).origin,
      fn: f,
      start: x,
      end: x + (layout.w[i] ?? 0),
      isSelf,
    });
  };
  for (let i = 0; i < sw.callers.length; i++) {
    const level = -((sw.callers.depth[i] ?? 0) - 1);
    if (level < 0 && level >= -SANDWICH_CALLER_LEVELS) push(sw.callers, i, level);
  }
  rows.push({
    level: 0,
    name: s.info(fn).name,
    origin: s.info(fn).origin,
    fn,
    start: 0,
    end: 1,
    isSelf: false,
  });
  let childEnd = 0;
  for (let i = 0; i < sw.callees.length; i++) {
    const level = (sw.callees.depth[i] ?? 0) - 1;
    if (level < 1 || level > SANDWICH_CALLEE_LEVELS) continue;
    if ((sw.callees.w[i] ?? 0) < MIN_SANDWICH_WIDTH) continue;
    push(sw.callees, i, level);
    if (level === 1) childEnd = Math.max(childEnd, (sw.callees.x[i] ?? 0) + (sw.callees.w[i] ?? 0));
  }
  const selfFrac = (sw.callees.self[1] ?? 0) / total;
  if (selfFrac > 0) {
    rows.push({
      level: 1,
      name: 'self',
      origin: -1,
      fn: null,
      start: childEnd,
      end: Math.min(1, childEnd + selfFrac),
      isSelf: true,
    });
  }
  return rows;
}

// ---- Call graph ----

export function callGraphData(
  model: ExecutionModel,
  s: Scoped,
  query: { all: boolean; revealed: number[] },
  memberCount: (pkg: string) => number,
): CallGraphData {
  const options = {
    ...(query.all ? { coverage: 1, maxNodes: 200 } : {}),
    expanded: query.revealed.map((f) => s.inn(f)).filter((f) => f >= 0),
  };
  let g = callGraph(model, s.view, options);
  // The engine prunes by self time only, so one dominant function can leave nodes without a
  // single edge. Open the heaviest node's neighbours so the graph shows how it is reached.
  const heaviest = g.nodes[0];
  if (g.edges.length === 0 && heaviest) {
    g = callGraph(model, s.view, { ...options, expanded: [...options.expanded, heaviest.fn] });
  }
  const byFn = new Map(g.nodes.map((n) => [s.out(n.fn), n]));
  const nodes: CgNode[] = g.nodes.map((n) => {
    const fn = s.out(n.fn);
    const info = s.info(fn);
    const loc = info.synthetic
      ? ''
      : info.origin === Origin.User || info.origin === Origin.Dependency
        ? locationOf(info)
        : '';
    const sub = n.isEntry
      ? 'entry point'
      : info.synthetic
        ? 'package'
        : loc
          ? (loc.split('/').pop() ?? loc)
          : info.origin === Origin.Node
            ? 'node'
            : info.origin === Origin.Native
              ? 'native'
              : info.origin === Origin.Gc
                ? 'V8'
                : '';
    return {
      fn,
      name: info.name || '(anonymous)',
      sub,
      origin: info.origin,
      isPackage: n.isPackage,
      isEntry: n.isEntry,
      recursion: n.recursion,
      selfUs: n.self,
      totalUs: n.total,
      hiddenCallers: n.hiddenCallers,
      hiddenCallees: n.hiddenCallees,
      members: n.isPackage ? memberCount(info.name) : 0,
    };
  });
  const edges: CgEdge[] = g.edges.map((e) => {
    const from = s.out(e.from);
    return {
      from,
      to: s.out(e.to),
      timeUs: e.weight,
      share: e.weight / (byFn.get(from)?.total || 1),
      calls: e.count,
      back: e.back,
      hiddenFrames: e.hiddenFrames,
    };
  });
  return {
    nodes,
    edges,
    shownFns: g.nodes.length,
    totalFns: g.nodes.length + g.hiddenNodes,
    maxSelfUs: Math.max(1, ...nodes.map((n) => n.selfUs)),
    maxTotalUs: Math.max(1, ...nodes.map((n) => n.totalUs)),
    maxEdgeUs: Math.max(1, ...edges.map((e) => e.timeUs)),
  };
}

/** Functions inside the engine's ego neighbourhood (2 callers up, 2 callees down). */
export function egoNeighbourhood(model: ExecutionModel, s: Scoped, fn: number): number[] | null {
  const engineFn = s.inn(fn);
  if (engineFn < 0) return null;
  const g = callGraph(model, s.view, { ego: engineFn, maxNodes: 1000 });
  return g.nodes.filter((n) => !n.faded).map((n) => s.out(n.fn));
}

// ---- Source ----

export function sourceInfo(model: ExecutionModel, s: Scoped, fn: number): SourceInfo | null {
  const engineFn = s.inn(fn);
  if (engineFn < 0 || engineFn >= model.functions.length) return null;
  const src = functionSource(model, s.view, engineFn);
  const peak = Math.max(1e-9, ...src.sparkline);
  return {
    fn,
    path: src.file,
    startLine: src.line,
    definitionLine: src.definitionLine || src.line,
    lineSelf: src.lines.map((l) => ({ line: l.line, selfUs: l.selfUs })),
    hottestLine: src.hottestLine,
    spark: Array.from(src.sparkline, (v) => v / peak),
    sparkTrack: s.track.label,
    durationUs: Math.max(1, model.meta.durationUs),
    mapMissing: src.mapMissing,
    mapped: model.functions.mapped[engineFn] === 1,
    loc: src.file ? fileLine(src.file, src.line) : '',
    lineStatus: src.lineInfo.status,
    lineReason: src.lineInfo.reason,
    calleeTime: calleesOf(model, s, engineFn).map((c) => {
      const fn = s.out(c.fn);
      return {
        fn,
        name: s.info(fn).name || '(anonymous)',
        origin: s.info(fn).origin,
        selfUs: c.selfUs,
        totalUs: c.totalUs,
      };
    }),
  };
}

/** Functions that ran in the same file as `fn`, in line order. */
export function fileOutline(model: ExecutionModel, s: Scoped, fn: number): FileOutline | null {
  const engineFn = s.inn(fn);
  if (engineFn < 0 || engineFn >= model.functions.length) return null;
  const file = s.info(fn).file;
  if (!file) return null;
  const items = functionRows(model, s.view, { includeIdle: true })
    .filter((r) => r.file === file && r.fn < model.functions.length)
    .map((r) => ({
      fn: r.fn,
      name: r.name || '(anonymous)',
      line: r.line,
      selfUs: r.self,
      totalUs: r.total,
      origin: r.origin,
    }))
    .sort((a, b) => a.line - b.line || a.name.localeCompare(b.name) || a.fn - b.fn);
  return { path: file, items };
}

// ---- Hot paths and hidden time ----

export function hotPathRows(model: ExecutionModel, s: Scoped, limit: number): HotPathRow[] {
  return hotPaths(model, s.trackIndex, { limit }).map((p) => {
    const last = p.locations[p.locations.length - 1];
    return {
      fns: p.fns,
      names: p.locations.map((l) => l.name || '(anonymous)'),
      loc: last ? fileLine(last.file, last.line) : '',
      selfUs: p.selfUs,
      totalUs: p.totalUs,
      share: p.share,
    };
  });
}

/** Self time of each origin the filter hides, read from the view without the filter. */
export function hiddenTime(
  model: ExecutionModel,
  unfiltered: Scoped,
  origins: number[],
): HiddenOrigin[] {
  return origins.map((origin) => ({
    origin,
    selfUs: functionRows(model, unfiltered.view, {
      origins: [origin as OriginId],
      includeIdle: true,
    }).reduce((sum, r) => sum + r.self, 0),
  }));
}

// ---- Overview lanes ----

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

/**
 * Dominant origin per task for the lane colors. The engine has no per-task origin summary, so this
 * reads the samples of each task: your code when it is at least 20% of busy time, else the
 * largest other origin.
 */
function dominantOrigins(model: ExecutionModel, track: Track): Uint8Array {
  const { tasks, samples, callTree } = track;
  const out = new Uint8Array(tasks.length);
  let si = 0;
  for (let ti = 0; ti < tasks.length; ti++) {
    const start = tasks.start[ti] ?? 0;
    const end = tasks.end[ti] ?? 0;
    while (si < samples.length && (samples.time[si] ?? 0) < start) si++;
    const w = new Float64Array(7);
    for (let j = si; j < samples.length && (samples.time[j] ?? 0) < end; j++) {
      const o = model.functions.origin[callTree.fn[samples.node[j] ?? 0] ?? 0] ?? 0;
      w[o] = (w[o] ?? 0) + 1;
    }
    let busy = 0;
    for (let o = 0; o < 7; o++) if (o !== Origin.Idle) busy += w[o] ?? 0;
    let best = 0;
    if ((w[Origin.User] ?? 0) < busy * 0.2) {
      let bw = -1;
      for (let o = 1; o < 7; o++) {
        if (o !== Origin.Idle && (w[o] ?? 0) > bw) {
          bw = w[o] ?? 0;
          best = o;
        }
      }
    }
    out[ti] = best;
  }
  return out;
}

export function overviewData(
  model: ExecutionModel,
  bins = 240,
): { durationUs: number; bins: number; lanes: LaneData[] } {
  const durationUs = Math.max(model.meta.durationUs, ...model.tracks.map((t) => t.durationUs), 1);
  const lanes = trackOrder(model).map((index): LaneData => {
    const track = model.tracks[index] as Track;
    const lane = timelineLane(model, index, { buckets: bins, start: 0, end: durationUs });
    const n = track.tasks.length;
    const taskStart = new Float64Array(n);
    const taskEnd = new Float64Array(n);
    const taskLong = new Uint8Array(n);
    const taskLabels: string[] = new Array<string>(n).fill('');
    for (const b of lane.tasks) {
      taskStart[b.task] = b.start;
      taskEnd[b.task] = b.end;
      taskLong[b.task] = b.long ? 1 : 0;
      taskLabels[b.task] = b.label;
    }
    const binW = durationUs / bins;
    const delay = new Float32Array(bins);
    let peak = 0;
    let peakAt = 0;
    for (const m of lane.loopDelay) {
      const b = Math.min(bins - 1, Math.max(0, Math.floor(m.time / binW)));
      delay[b] = Math.max(delay[b] ?? 0, m.durationUs);
      if (m.durationUs > peak) {
        peak = m.durationUs;
        peakAt = m.time;
      }
    }
    const text = laneText(model, track);
    return {
      id: track.id,
      label: text.title,
      meta: text.meta,
      support: track.role === 'support',
      durationUs,
      cpu: lane.cpu,
      taskStart,
      taskEnd,
      taskLong,
      taskOrigin: dominantOrigins(model, track),
      taskLabels,
      gcTime: Float64Array.from(lane.gc, (g) => g.time),
      gcDuration: Float64Array.from(lane.gc, (g) => g.durationUs),
      delay,
      peakDelayUs: peak,
      peakDelayAtUs: peakAt,
      hasLoopData: lane.loopDelay.length > 0,
    };
  });
  return { durationUs, bins, lanes };
}
