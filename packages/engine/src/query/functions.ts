// Functions table rows and the sandwich (callers inverted above, callees below).
//
// `calls` is the estimated call count: contiguous runs of samples seen inside the function's call
// nodes, summed over all its nodes (nested recursive runs count separately).

import { Origin } from '../model.js';
import type { CallTree, ExecutionModel } from '../model.js';
import { compareText } from '../util/compare.js';
import { depthsOf, preorder, subtreeEnds, totalsOf } from '../util/tree-columns.js';
import { createTreeBuilder } from './tree-builder.js';
import { runsPerNode } from './callgraph.js';
import { flameLayoutOfTree } from './flame.js';
import type {
  FunctionRow,
  FunctionRowsOptions,
  FunctionSortKey,
  Sandwich,
  TransformedView,
  ViewFnId,
} from './types.js';
import { describeFunction } from './view.js';

const TEXT_KEYS = new Set<FunctionSortKey>(['name', 'package', 'file', 'origin']);

export function functionRows(
  model: ExecutionModel,
  view: TransformedView,
  options: FunctionRowsOptions = {},
): FunctionRow[] {
  const tree = view.tree;
  const F = model.functions.length;
  const sort = options.sort ?? 'self';
  const direction = options.direction ?? (TEXT_KEYS.has(sort) ? 'asc' : 'desc');
  const userFirst = options.userFirst ?? true;
  const needle = (options.search ?? '').trim().toLowerCase();
  const runs = runsPerNode(tree, view.samples);

  const self = new Map<number, number>();
  const total = new Map<number, number>();
  const calls = new Map<number, number>();
  const active = new Map<number, number>();
  const open: number[] = [];
  const rootFn = tree.fn[0] ?? 0;
  for (let i = 1; i < tree.length; i++) {
    while (open.length > 0 && (tree.subtreeEnd[open[open.length - 1] ?? 0] ?? 0) <= i) {
      const done = tree.fn[open.pop() ?? 0] ?? 0;
      active.set(done, (active.get(done) ?? 1) - 1);
    }
    const fn = tree.fn[i] ?? 0;
    self.set(fn, (self.get(fn) ?? 0) + (tree.self[i] ?? 0));
    calls.set(fn, (calls.get(fn) ?? 0) + (runs[i] ?? 0));
    if ((active.get(fn) ?? 0) === 0) total.set(fn, (total.get(fn) ?? 0) + (tree.total[i] ?? 0));
    active.set(fn, (active.get(fn) ?? 0) + 1);
    open.push(i);
  }

  const rows: FunctionRow[] = [];
  for (const [fn, t] of total) {
    if (fn === rootFn) continue;
    const info = describeFunction(model, fn, view.syntheticPackages);
    if (
      !options.includeIdle &&
      fn < F &&
      (info.origin === Origin.Idle || info.origin === Origin.Gc)
    ) {
      continue;
    }
    if (options.origins && !options.origins.includes(info.origin)) continue;
    if (options.pkg !== undefined && info.pkg !== options.pkg) continue;
    if (
      needle &&
      !info.name.toLowerCase().includes(needle) &&
      !info.file.toLowerCase().includes(needle) &&
      !info.pkg.toLowerCase().includes(needle)
    ) {
      continue;
    }
    const s = self.get(fn) ?? 0;
    rows.push({
      fn,
      name: info.name,
      file: info.file,
      line: info.line,
      pkg: info.pkg,
      origin: info.origin,
      plumbing: info.plumbing,
      self: s,
      total: t,
      selfShare: view.totalUs > 0 ? s / view.totalUs : 0,
      totalShare: view.totalUs > 0 ? t / view.totalUs : 0,
      calls: calls.get(fn) ?? 0,
    });
  }

  const sign = direction === 'asc' ? 1 : -1;
  const key = (a: FunctionRow, b: FunctionRow): number => {
    switch (sort) {
      case 'self':
        return a.self - b.self;
      case 'total':
        return a.total - b.total;
      case 'calls':
        return a.calls - b.calls;
      case 'origin':
        return a.origin - b.origin;
      case 'name':
        return compareText(a.name, b.name);
      case 'package':
        return compareText(a.pkg, b.pkg);
      case 'file':
        return compareText(a.file, b.file);
    }
  };
  const group = (r: FunctionRow): number => (userFirst && r.origin !== Origin.User ? 1 : 0);
  return rows.sort((a, b) => group(a) - group(b) || sign * key(a, b) || a.fn - b.fn);
}

/** Builds a tree in creation order, then renumbers it to preorder with totals. */
function buildTree(
  rootFn: number,
  K: number,
  fill: (
    child: (parent: number, fn: number) => number,
    addSelf: (node: number, us: number) => void,
  ) => void,
): CallTree {
  const { parent, fn, child } = createTreeBuilder(rootFn, K);
  const self: number[] = [];
  fill(child, (node, us) => {
    self[node] = (self[node] ?? 0) + us;
  });
  const m = parent.length;
  const kids: number[][] = Array.from({ length: m }, () => []);
  for (let i = 1; i < m; i++) kids[parent[i] ?? 0]?.push(i);
  const order = preorder(kids);
  const newId = new Int32Array(m);
  order.forEach((old, i) => {
    newId[old] = i;
  });
  const tParent = new Int32Array(m);
  const tFn = new Uint32Array(m);
  const tSelf = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const old = order[i] ?? 0;
    tFn[i] = fn[old] ?? 0;
    tSelf[i] = self[old] ?? 0;
    const p = i === 0 ? -1 : (newId[parent[old] ?? 0] ?? 0);
    tParent[i] = p;
  }
  return {
    length: m,
    parent: tParent,
    fn: tFn,
    depth: depthsOf(tParent),
    subtreeEnd: subtreeEnds(tParent),
    self: tSelf,
    total: totalsOf(tParent, tSelf),
  };
}

export function sandwich(model: ExecutionModel, view: TransformedView, fn: ViewFnId): Sandwich {
  const tree = view.tree;
  const K = model.functions.length + view.syntheticPackages.length + 1;
  const rootFn = tree.fn[0] ?? 0;

  // Outermost occurrences of fn.
  const outermost: number[] = [];
  for (let i = 1; i < tree.length;) {
    if (tree.fn[i] === fn) {
      outermost.push(i);
      i = tree.subtreeEnd[i] ?? i + 1;
    } else i++;
  }

  const callees = buildTree(rootFn, K, (child, addSelf) => {
    const map = new Map<number, number>();
    for (const o of outermost) {
      const top = child(0, fn);
      map.set(o, top);
      addSelf(top, tree.self[o] ?? 0);
      for (let i = o + 1; i < (tree.subtreeEnd[o] ?? 0); i++) {
        const node = child(map.get(tree.parent[i] ?? 0) ?? top, tree.fn[i] ?? 0);
        map.set(i, node);
        addSelf(node, tree.self[i] ?? 0);
      }
    }
  });

  const callers = buildTree(rootFn, K, (child, addSelf) => {
    for (const o of outermost) {
      let at = child(0, fn);
      let last = at;
      for (let a = tree.parent[o] ?? 0; a > 0; a = tree.parent[a] ?? 0) {
        at = child(at, tree.fn[a] ?? 0);
        last = at;
      }
      addSelf(last, tree.total[o] ?? 0);
    }
  });

  return {
    fn,
    callers: flameLayoutOfTree(model, callers, view.syntheticPackages),
    callees: flameLayoutOfTree(model, callees, view.syntheticPackages),
  };
}
