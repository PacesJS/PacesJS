// Timed call-tree queries for agents and the CLI: the same transform stack as the UI (stitched
// continuations, plumbing merged, dependencies collapsed), cut down to a readable number of rows.
// Function ids are `f<index in model.functions>`: valid for the model of one session file (same
// capture, same engine version), and identical on every invocation against it.

import { Origin } from '../model.js';
import { functionName } from '../frames.js';
import type { ExecutionModel, FnId, OriginId } from '../model.js';
import type { FunctionInfo, Transform, TransformedView } from './types.js';
import { SHOWN_PREFIX, hideAllExcept } from './stacks.js';
import { applyTransforms, describeFunction, nodePath } from './view.js';
import { trackAt } from './track-at.js';

export type TreeSort = 'total' | 'self' | 'time';

/** A resolved function, optionally pinned to one call chain (root's child first) for path selectors. */
export interface TreeSelector {
  fn: FnId;
  path?: FnId[];
}

export interface TreeQueryOptions {
  /** Root the tree at this function (all its call sites merged) or at one call chain. */
  from?: TreeSelector;
  /** Rows deeper than this below the root are folded. Default 6. */
  depth?: number;
  /** Rows under this many microseconds are folded. Default: `minShare` of the root. */
  minUs?: number;
  /** Rows under this share of the root's total are folded. Default 0.01. */
  minShare?: number;
  /** Order of siblings: heaviest total, heaviest self, or execution order. Default 'total'. */
  sort?: TreeSort;
  /** Keep only these origins; hidden frames fold into their nearest kept caller (self moves up). */
  origins?: OriginId[];
  /** Packages shown in full while the rest of the dependencies stay collapsed. */
  expandPkgs?: string[];
  /** Collapse dependency packages into one node each, like the UI. Default true. */
  collapseDeps?: boolean;
  /** A task index of the track, or the whole run (default). */
  task?: number | 'whole';
  /** Stop after this many rows (depth-first); the rest count as hidden. */
  maxRows?: number;
}

export interface TreeRow {
  /** `f123` for functions (stable for a session file), `p:<pkg>` for a collapsed package. */
  id: string;
  fn: number;
  depth: number;
  name: string;
  file: string;
  line: number;
  origin: OriginId;
  pkg: string;
  synthetic: boolean;
  totalUs: number;
  selfUs: number;
  /** `totalUs` as a share of the whole view (the whole run or the chosen task), 0..1. */
  share: number;
  /** Rows below this one that were left out (too small, too deep or past `maxRows`). */
  folded?: number;
}

export interface TreeResult {
  trackIndex: number;
  rows: TreeRow[];
  /** Total of the row at depth 0 (or of the whole view without `from`). Thresholds are relative to it. */
  rootUs: number;
  /** Total of the whole view that `share` is relative to. */
  viewUs: number;
  /** Rows left out in total. */
  hidden: number;
  /** Rows that exist in the tree under the root. */
  available: number;
}

export interface SelectorResult {
  matches: Array<{ fn: FnId; path?: FnId[]; totalUs: number }>;
  how: 'exact' | 'path' | 'location' | 'id' | 'substring';
}

export const functionId = (fn: number): string => `f${fn}`;

const fileOf = (model: ExecutionModel, fn: FnId): string =>
  (model.strings[model.functions.file[fn] ?? 0] ?? '').replaceAll('\\', '/');

function taskStack(model: ExecutionModel, trackIndex: number, task: number | 'whole'): Transform[] {
  const stack: Transform[] = [{ kind: 'stitch-continuations' }];
  if (task !== 'whole') {
    const tasks = trackAt(model, trackIndex).tasks;
    if (!Number.isInteger(task) || task < 0 || task >= tasks.length) {
      throw new Error(
        `No task ${String(task)} on this track; it has ${tasks.length} tasks (0 to ${tasks.length - 1}).`,
      );
    }
    stack.push({ kind: 'time-range', start: tasks.start[task] ?? 0, end: tasks.end[task] ?? 0 });
  }
  stack.push({ kind: 'merge-plumbing' }, { kind: 'drop-idle' });
  return stack;
}

/**
 * Finds functions by text: `f123` (id), `path/suffix.js:1007` (definition line), `a,b,c` (each step a
 * descendant of the previous, not necessarily a child), or a name (exact first, then substring).
 * Matches are sorted by total time, heaviest first.
 */
export function resolveSelector(
  model: ExecutionModel,
  trackIndex: number,
  text: string,
): SelectorResult {
  const track = trackAt(model, trackIndex);
  const sel = text.trim();
  const slot = new Map<FnId, number>();
  track.fnIds.forEach((fn, i) => slot.set(fn, i));
  const total = (fn: FnId): number => track.agg.fnTotal[slot.get(fn) ?? -1] ?? 0;
  const rank = (fns: FnId[]): SelectorResult['matches'] =>
    fns
      .map((fn) => ({ fn, totalUs: total(fn) }))
      .sort((a, b) => b.totalUs - a.totalUs || a.fn - b.fn);

  const id = /^f(\d+)$/.exec(sel);
  if (id) {
    const fn = Number(id[1]);
    // Ids printed by a tree include stitched roots, which are in the table but not in the track's list.
    return { matches: slot.has(fn) || fn < model.functions.length ? rank([fn]) : [], how: 'id' };
  }

  if (sel.includes(',')) {
    const steps = sel
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const view = applyTransforms(model, trackIndex, SHOWN_PREFIX);
    const tree = view.tree;
    const names = Array.from({ length: tree.length }, (_, n) =>
      n === 0 ? '' : describeFunction(model, tree.fn[n] ?? 0, view.syntheticPackages).name,
    );
    // Per step: exact names when any exist anywhere, else substrings.
    const test = steps.map((s) => {
      const exact = names.some((n) => n === s);
      return (n: string): boolean => (exact ? n === s : n.includes(s));
    });
    const progress = new Int32Array(tree.length);
    const hits = new Map<string, { node: number; fn: FnId }>();
    for (let n = 1; n < tree.length; n++) {
      const p = progress[tree.parent[n] ?? 0] ?? 0;
      const next = test[p]?.(names[n] ?? '') ? p + 1 : p;
      progress[n] = next;
      if (next === steps.length && p === steps.length - 1) {
        const key = nodePath(tree, n).join(',');
        hits.set(key, { node: n, fn: tree.fn[n] ?? 0 });
      }
    }
    const byFn = new Map<FnId, { path: FnId[]; us: number }>();
    for (const { node, fn } of hits.values()) {
      const us = tree.total[node] ?? 0;
      const prior = byFn.get(fn);
      if (!prior || us > prior.us) byFn.set(fn, { path: nodePath(tree, node), us });
    }
    const matches = [...byFn.entries()]
      .map(([fn, v]) => ({ fn, path: v.path, totalUs: v.us }))
      .sort((a, b) => b.totalUs - a.totalUs || a.fn - b.fn);
    return { matches, how: 'path' };
  }

  const loc = /^(.+[./\\].*|.*\.\w+):(\d+)$/.exec(sel);
  if (loc) {
    const suffix = (loc[1] as string).replaceAll('\\', '/');
    const line = Number(loc[2]);
    const inFile = Array.from(track.fnIds).filter((fn) => {
      const f = fileOf(model, fn);
      return f === suffix || f.endsWith(`/${suffix}`);
    });
    const exact = inFile.filter((fn) => (model.functions.line[fn] ?? 0) === line);
    if (exact.length > 0) return { matches: rank(exact), how: 'location' };
    // A line inside a function: the nearest definition above it.
    const above = inFile
      .filter((fn) => (model.functions.line[fn] ?? 0) <= line)
      .sort((a, b) => (model.functions.line[b] ?? 0) - (model.functions.line[a] ?? 0));
    const best = above[0];
    return {
      matches:
        best === undefined
          ? []
          : rank(above.filter((fn) => model.functions.line[fn] === model.functions.line[best])),
      how: 'location',
    };
  }

  // Anonymous functions are shown as "(anonymous)" but stored with an empty name.
  const wanted = sel === '(anonymous)' ? '' : sel;
  const exact = Array.from(track.fnIds).filter((fn) => functionName(model, fn) === wanted);
  if (exact.length > 0) return { matches: rank(exact), how: 'exact' };
  const loose = Array.from(track.fnIds).filter(
    (fn) => sel !== '' && functionName(model, fn).includes(sel),
  );
  return { matches: rank(loose), how: 'substring' };
}

function stackFor(
  model: ExecutionModel,
  trackIndex: number,
  options: TreeQueryOptions,
): Transform[] {
  const stack = taskStack(model, trackIndex, options.task ?? 'whole');
  const from = options.from;
  if (from) {
    stack.push(
      from.path && from.path.length > 0
        ? { kind: 'focus-subtree', path: from.path }
        : { kind: 'focus-function', fn: from.fn },
    );
  }
  const expand = new Set(options.expandPkgs ?? []);
  if (options.collapseDeps !== false) {
    if (expand.size === 0) stack.push({ kind: 'collapse-dependencies' });
    else {
      const pkgs = new Set<string>();
      for (const fn of trackAt(model, trackIndex).fnIds) {
        const o = model.functions.origin[fn];
        const pkg = model.strings[model.functions.pkg[fn] ?? 0] ?? '';
        if ((o === Origin.Dependency || o === Origin.Framework) && pkg !== '' && !expand.has(pkg)) {
          pkgs.add(pkg);
        }
      }
      for (const pkg of [...pkgs].sort()) stack.push({ kind: 'collapse-package', pkg });
    }
  }
  if (options.origins) {
    const hide = hideAllExcept(options.origins);
    if (hide) stack.push(hide);
  }
  return stack;
}

function firstSampleTimes(view: TransformedView): Float64Array {
  const tree = view.tree;
  const first = new Float64Array(tree.length).fill(Number.POSITIVE_INFINITY);
  for (let s = 0; s < view.samples.length; s++) {
    const n = view.samples.node[s] ?? 0;
    const t = view.samples.time[s] ?? 0;
    if (t < (first[n] ?? Number.POSITIVE_INFINITY)) first[n] = t;
  }
  for (let n = tree.length - 1; n > 0; n--) {
    const p = tree.parent[n] ?? 0;
    if ((first[n] ?? 0) < (first[p] ?? 0)) first[p] = first[n] as number;
  }
  return first;
}

export function callTreeQuery(
  model: ExecutionModel,
  trackIndex: number,
  options: TreeQueryOptions = {},
): TreeResult {
  trackAt(model, trackIndex);
  const maxDepth = options.depth ?? 6;
  const sort = options.sort ?? 'total';
  const minShare = options.minShare ?? 0.01;

  const viewUs =
    applyTransforms(model, trackIndex, taskStack(model, trackIndex, options.task ?? 'whole'))
      .totalUs || 1;
  const view = applyTransforms(model, trackIndex, stackFor(model, trackIndex, options));
  const tree = view.tree;
  const time = sort === 'time' ? firstSampleTimes(view) : undefined;

  const topLevel: number[] = [];
  for (let c = 1; c < tree.length; c = tree.subtreeEnd[c] ?? c + 1) topLevel.push(c);
  // `from` roots the view at one node; without it the stitched entry is the top row.
  const roots = topLevel;
  const rootUs = roots.reduce((n, r) => n + (tree.total[r] ?? 0), 0);
  const floor = Math.max(options.minUs ?? 0, minShare * rootUs);
  const cap = options.maxRows ?? Number.POSITIVE_INFINITY;

  const order = (nodes: number[]): number[] =>
    nodes.sort((a, b) => {
      if (sort === 'time') return (time?.[a] ?? 0) - (time?.[b] ?? 0) || a - b;
      const x = sort === 'self' ? (tree.self[b] ?? 0) - (tree.self[a] ?? 0) : 0;
      return (
        x || (tree.total[b] ?? 0) - (tree.total[a] ?? 0) || (tree.fn[a] ?? 0) - (tree.fn[b] ?? 0)
      );
    });

  const rows: TreeRow[] = [];
  let hidden = 0;
  const subtree = (n: number): number => (tree.subtreeEnd[n] ?? n + 1) - n;

  const visit = (n: number, depth: number): number => {
    const fn = tree.fn[n] ?? 0;
    const info: FunctionInfo = describeFunction(model, fn, view.syntheticPackages);
    const row: TreeRow = {
      id: info.synthetic ? `p:${info.pkg}` : functionId(fn),
      fn,
      depth,
      name: info.name,
      file: info.file.replaceAll('\\', '/'),
      line: info.line,
      origin: info.origin,
      pkg: info.pkg,
      synthetic: info.synthetic,
      totalUs: tree.total[n] ?? 0,
      selfUs: tree.self[n] ?? 0,
      share: (tree.total[n] ?? 0) / viewUs,
    };
    rows.push(row);
    let left = 0;
    const kids = order(childrenNodes(n));
    for (const c of kids) {
      if (depth + 1 >= maxDepth || (tree.total[c] ?? 0) < floor || rows.length >= cap) {
        left += subtree(c);
      } else left += visit(c, depth + 1);
    }
    if (left > 0) row.folded = left;
    return left;
  };

  const childrenNodes = (n: number): number[] => {
    const out: number[] = [];
    for (let c = n + 1; c < (tree.subtreeEnd[n] ?? 0); c = tree.subtreeEnd[c] ?? c + 1) out.push(c);
    return out;
  };

  let available = 0;
  for (const r of order([...roots])) {
    available += subtree(r);
    if ((tree.total[r] ?? 0) < floor || rows.length >= cap) hidden += subtree(r);
    else hidden += visit(r, 0);
  }
  return { trackIndex, rows, rootUs, viewUs, hidden, available };
}
