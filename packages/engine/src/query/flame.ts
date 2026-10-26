// Flame graph layout: stacks merged by the call tree, laid out as fractions of the root width.

import { Origin } from '../model.js';
import type { CallTree, ExecutionModel } from '../model.js';
import type { FlameLayout, FlameOptions, TransformedView } from './types.js';
import { deoptCounts } from './deopts.js';
import { childrenOf, describeFunction } from './view.js';

export function flameLayout(
  model: ExecutionModel,
  view: TransformedView,
  options: FlameOptions = {},
): FlameLayout {
  const deopts = deoptCounts(model, view.trackIndex, view.syntheticPackages);
  return flameLayoutOfTree(model, view.tree, view.syntheticPackages, options, deopts);
}

export function flameLayoutOfTree(
  model: ExecutionModel,
  tree: CallTree,
  syntheticPackages: readonly string[],
  options: FlameOptions = {},
  deopts: Uint32Array = new Uint32Array(0),
): FlameLayout {
  const F = model.functions.length;
  const sort = options.sort ?? 'left-heavy';
  const colorBy = options.colorBy ?? 'origin';
  const minWidth = options.minWidth ?? 0;
  const diff = options.diff;
  if (colorBy === 'diff' && !diff) {
    throw new Error(
      "flameLayout: colorBy 'diff' needs options.diff; build it with diffModels(base, head).",
    );
  }
  const root =
    options.zoomNode !== undefined && options.zoomNode < tree.length ? options.zoomNode : 0;
  const rootTotal = tree.total[root] ?? 0;
  const baseDepth = tree.depth[root] ?? 0;

  const zoomPath: number[] = [];
  for (let n = root; n >= 0; n = tree.parent[n] ?? -1) zoomPath.push(n);
  zoomPath.reverse();

  const names = new Map<number, string>();
  const nameOf = (fn: number): string => {
    let s = names.get(fn);
    if (s === undefined) {
      s = describeFunction(model, fn, syntheticPackages).name;
      names.set(fn, s);
    }
    return s;
  };
  const order = (a: number, b: number): number => {
    const fa = tree.fn[a] ?? 0;
    const fb = tree.fn[b] ?? 0;
    if (sort === 'alphabetical') {
      const na = nameOf(fa);
      const nb = nameOf(fb);
      if (na !== nb) return na < nb ? -1 : 1;
    } else {
      const d = (tree.total[b] ?? 0) - (tree.total[a] ?? 0);
      if (d !== 0) return d;
    }
    return fa - fb || a - b;
  };

  const node: number[] = [];
  const xs: number[] = [];
  const ws: number[] = [];
  const stack: Array<[number, number]> = [[root, 0]];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    const [n, x] = entry;
    const w = rootTotal > 0 ? (tree.total[n] ?? 0) / rootTotal : 0;
    if (n !== root && w < minWidth) continue;
    node.push(n);
    xs.push(x);
    ws.push(w);
    const kids = childrenOf(tree, n).sort(order);
    const starts: number[] = [];
    let cursor = x;
    for (const k of kids) {
      starts.push(cursor);
      cursor += rootTotal > 0 ? (tree.total[k] ?? 0) / rootTotal : 0;
    }
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i] ?? 0, starts[i] ?? 0]);
  }

  const length = node.length;
  const out: FlameLayout = {
    length,
    node: Uint32Array.from(node),
    fn: new Uint32Array(length),
    depth: new Uint16Array(length),
    row: new Uint16Array(length),
    x: Float64Array.from(xs),
    w: Float64Array.from(ws),
    self: new Float64Array(length),
    total: new Float64Array(length),
    origin: new Uint8Array(length),
    plumbing: new Uint8Array(length),
    intensity: new Float32Array(length),
    change: new Int8Array(length),
    deopts: new Uint32Array(length),
    maxDepth: 0,
    totalUs: rootTotal,
    zoomPath,
  };
  let maxDepth = 0;
  let maxSelf = 0;
  let maxDelta = 0;
  for (let i = 0; i < length; i++) {
    const n = node[i] ?? 0;
    const fn = tree.fn[n] ?? 0;
    const depth = (tree.depth[n] ?? 0) - baseDepth;
    out.fn[i] = fn;
    out.depth[i] = depth;
    out.self[i] = tree.self[n] ?? 0;
    out.total[i] = tree.total[n] ?? 0;
    out.origin[i] = fn >= F ? Origin.Dependency : (model.functions.origin[fn] ?? 0);
    out.plumbing[i] = fn >= F ? 0 : (model.functions.plumbing[fn] ?? 0);
    out.deopts[i] = deopts[fn] ?? 0;
    if (depth > maxDepth) maxDepth = depth;
    if ((tree.self[n] ?? 0) > maxSelf) maxSelf = tree.self[n] ?? 0;
    if (colorBy === 'diff' && diff && fn < diff.headChange.length) {
      out.change[i] = diff.headChange[fn] ?? 0;
      maxDelta = Math.max(maxDelta, Math.abs(diff.headSelfShareDelta[fn] ?? 0));
    }
  }
  out.maxDepth = maxDepth;
  for (let i = 0; i < length; i++) {
    out.row[i] =
      options.orientation === 'classic' ? maxDepth - (out.depth[i] ?? 0) : (out.depth[i] ?? 0);
    if (colorBy === 'self' && maxSelf > 0) out.intensity[i] = (out.self[i] ?? 0) / maxSelf;
    else if (colorBy === 'diff' && diff && maxDelta > 0) {
      const fn = out.fn[i] ?? 0;
      if (fn < diff.headSelfShareDelta.length) {
        out.intensity[i] = Math.abs(diff.headSelfShareDelta[fn] ?? 0) / maxDelta;
      }
    }
  }
  return out;
}
