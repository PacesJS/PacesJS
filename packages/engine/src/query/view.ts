// The transform layer: a serializable stack of transforms applied to one track produces a
// `TransformedView` (tree plus surviving samples) that every view reads. Pure and allocation-light:
// each step is O(nodes + samples), so 60 000 samples transform in a few milliseconds.

import { Origin } from '../model.js';
import type { CallTree, ExecutionModel, Samples } from '../model.js';
import type { FunctionInfo, Transform, TransformedView, ViewFnId } from './types.js';

interface Working {
  tree: CallTree;
  samples: Samples;
  inverted: boolean;
  synthetic: string[];
}

/** How to rewrite a tree: per-node function (negative removes the node), and a per-sample filter. */
interface Plan {
  /** New function per old node; -1 merges the node into its parent. Length: tree.length. */
  fnOf: Int32Array;
  /** Folds a node into its parent when both end up with this function (collapse package). */
  foldSynthetic?: number;
  /** Maps a recursive occurrence of this function onto its outermost occurrence. */
  recurse?: number;
  /** Keeps only samples whose leaf node passes. */
  keepLeaf?: Uint8Array;
  /** Keeps only samples passing this test (by sample index). */
  keepSample?: (i: number) => boolean;
}

export function childrenOf(tree: CallTree, node: number): number[] {
  const out: number[] = [];
  const end = tree.subtreeEnd[node] ?? 0;
  for (let i = node + 1; i < end; i = tree.subtreeEnd[i] ?? i + 1) out.push(i);
  return out;
}

/** Function ids from the root's child down to `node`. */
export function nodePath(tree: CallTree, node: number): number[] {
  const path: number[] = [];
  for (let n = node; n > 0; n = tree.parent[n] ?? 0) path.push(tree.fn[n] ?? 0);
  return path.reverse();
}

/** The node reached by following `path` from the root, or -1. */
export function findNode(tree: CallTree, path: readonly number[]): number {
  let node = 0;
  for (const fn of path) {
    const next = childrenOf(tree, node).find((c) => tree.fn[c] === fn);
    if (next === undefined) return -1;
    node = next;
  }
  return node;
}

export function describeFunction(
  model: ExecutionModel,
  fn: ViewFnId,
  synthetic: readonly string[] = [],
): FunctionInfo {
  const F = model.functions.length;
  if (fn >= F) {
    const pkg = synthetic[fn - F] ?? '';
    return {
      fn,
      name: pkg,
      file: '',
      line: 0,
      col: 0,
      origin: Origin.Dependency,
      pkg,
      plumbing: false,
      mapped: false,
      mapMissing: false,
      synthetic: true,
    };
  }
  const f = model.functions;
  return {
    fn,
    name: model.strings[f.name[fn] ?? 0] ?? '',
    file: model.strings[f.file[fn] ?? 0] ?? '',
    line: f.line[fn] ?? 0,
    col: f.col[fn] ?? 0,
    origin: (f.origin[fn] ?? 0) as FunctionInfo['origin'],
    pkg: model.strings[f.pkg[fn] ?? 0] ?? '',
    plumbing: f.plumbing[fn] === 1,
    mapped: f.mapped[fn] === 1,
    mapMissing: f.mapMissing[fn] === 1,
    synthetic: false,
  };
}

/** Rewrites `work` according to `plan`: remaps nodes, filters samples, rebuilds a preorder tree. */
function rebuild(model: ExecutionModel, work: Working, plan: Plan): Working {
  const { tree, samples } = work;
  const n = tree.length;
  const nodeMap = new Int32Array(n);
  // Temporary tree in creation order.
  const parent: number[] = [-1];
  const fn: number[] = [tree.fn[0] ?? 0];
  const index = new Map<number, number>();
  const K = model.functions.length + work.synthetic.length + 1;
  const outer = plan.recurse !== undefined ? new Int32Array(n).fill(-1) : undefined;

  for (let i = 1; i < n; i++) {
    const oldParent = tree.parent[i] ?? 0;
    const p = nodeMap[oldParent] ?? 0;
    const newFn = plan.fnOf[i] ?? -1;
    const inherited = outer ? (outer[oldParent] ?? -1) : -1;
    if (newFn < 0) {
      nodeMap[i] = p;
      if (outer) outer[i] = inherited;
      continue;
    }
    if (outer && newFn === plan.recurse && inherited >= 0) {
      nodeMap[i] = inherited;
      outer[i] = inherited;
      continue;
    }
    if (
      plan.foldSynthetic !== undefined &&
      newFn >= plan.foldSynthetic &&
      p !== 0 &&
      fn[p] === newFn
    ) {
      nodeMap[i] = p;
      if (outer) outer[i] = inherited;
      continue;
    }
    const key = p * K + newFn;
    let node = index.get(key);
    if (node === undefined) {
      node = parent.length;
      parent.push(p);
      fn.push(newFn);
      index.set(key, node);
    }
    nodeMap[i] = node;
    if (outer) outer[i] = newFn === plan.recurse ? node : inherited;
  }

  // Samples.
  const count = samples.length;
  const keep = new Uint8Array(count);
  let kept = 0;
  for (let s = 0; s < count; s++) {
    const leaf = samples.node[s] ?? 0;
    const ok =
      (plan.keepLeaf === undefined || plan.keepLeaf[leaf] === 1) &&
      (plan.keepSample === undefined || plan.keepSample(s));
    keep[s] = ok ? 1 : 0;
    if (ok) kept++;
  }
  const time = new Float64Array(kept);
  const dur = new Float64Array(kept);
  const node = new Uint32Array(kept);
  const tmpTotal = new Float64Array(parent.length);
  let w = 0;
  for (let s = 0; s < count; s++) {
    if (!keep[s]) continue;
    time[w] = samples.time[s] ?? 0;
    dur[w] = samples.dur[s] ?? 0;
    const target = nodeMap[samples.node[s] ?? 0] ?? 0;
    node[w] = target;
    tmpTotal[target] = (tmpTotal[target] ?? 0) + (dur[w] ?? 0);
    w++;
  }
  return finish(work, parent, fn, time, dur, node, tmpTotal);
}

/** Orders a creation-order tree into preorder, prunes empty subtrees and computes self/total. */
function finish(
  work: Working,
  parent: number[],
  fn: number[],
  time: Float64Array,
  dur: Float64Array,
  node: Uint32Array,
  selfTmp: Float64Array,
): Working {
  const m = parent.length;
  const total = Float64Array.from(selfTmp);
  for (let i = m - 1; i > 0; i--)
    total[parent[i] ?? 0] = (total[parent[i] ?? 0] ?? 0) + (total[i] ?? 0);

  const firstChild = new Int32Array(m).fill(-1);
  const lastChild = new Int32Array(m).fill(-1);
  const nextSibling = new Int32Array(m).fill(-1);
  for (let i = 1; i < m; i++) {
    if ((total[i] ?? 0) <= 0 && (selfTmp[i] ?? 0) <= 0) continue;
    const p = parent[i] ?? 0;
    if ((lastChild[p] ?? -1) < 0) firstChild[p] = i;
    else nextSibling[lastChild[p] ?? 0] = i;
    lastChild[p] = i;
  }
  const order: number[] = [];
  const stack: number[] = [0];
  while (stack.length > 0) {
    const cur = stack.pop() ?? 0;
    order.push(cur);
    const kids: number[] = [];
    for (let c = firstChild[cur] ?? -1; c >= 0; c = nextSibling[c] ?? -1) kids.push(c);
    for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k] ?? 0);
  }
  const length = order.length;
  const newId = new Int32Array(m).fill(-1);
  order.forEach((old, i) => {
    newId[old] = i;
  });
  const tParent = new Int32Array(length);
  const tFn = new Uint32Array(length);
  const tDepth = new Uint16Array(length);
  const tEnd = new Uint32Array(length);
  const tSelf = new Float64Array(length);
  const tTotal = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    const old = order[i] ?? 0;
    tFn[i] = fn[old] ?? 0;
    tSelf[i] = selfTmp[old] ?? 0;
    tTotal[i] = total[old] ?? 0;
    const p = i === 0 ? -1 : (newId[parent[old] ?? 0] ?? 0);
    tParent[i] = p;
    tDepth[i] = p < 0 ? 0 : (tDepth[p] ?? 0) + 1;
  }
  for (let i = length - 1; i >= 0; i--) {
    if ((tEnd[i] ?? 0) < i + 1) tEnd[i] = i + 1;
    const p = tParent[i] ?? -1;
    if (p >= 0 && (tEnd[p] ?? 0) < (tEnd[i] ?? 0)) tEnd[p] = tEnd[i] ?? 0;
  }
  const remapped = new Uint32Array(node.length);
  for (let s = 0; s < node.length; s++) {
    const id = newId[node[s] ?? 0] ?? 0;
    remapped[s] = id < 0 ? 0 : id;
  }
  return {
    tree: {
      length,
      parent: tParent,
      fn: tFn,
      depth: tDepth,
      subtreeEnd: tEnd,
      self: tSelf,
      total: tTotal,
    },
    samples: { length: node.length, time, node: remapped, dur },
    inverted: work.inverted,
    synthetic: work.synthetic,
  };
}

function identityFns(tree: CallTree): Int32Array {
  return Int32Array.from(tree.fn);
}

/** Marks nodes that have `fn` as themselves or an ancestor. */
function underFunction(tree: CallTree, fn: number): Uint8Array {
  const under = new Uint8Array(tree.length);
  for (let i = 1; i < tree.length; i++) {
    under[i] = (under[tree.parent[i] ?? 0] ?? 0) === 1 || tree.fn[i] === fn ? 1 : 0;
  }
  return under;
}

function packageOf(model: ExecutionModel, work: Working, fn: number): string {
  const F = model.functions.length;
  if (fn >= F) return work.synthetic[fn - F] ?? '';
  return model.strings[model.functions.pkg[fn] ?? 0] ?? '';
}

function syntheticFor(model: ExecutionModel, work: Working, pkg: string): number {
  let at = work.synthetic.indexOf(pkg);
  if (at < 0) {
    work.synthetic = [...work.synthetic, pkg];
    at = work.synthetic.length - 1;
  }
  return model.functions.length + at;
}

function invert(model: ExecutionModel, work: Working): Working {
  const { tree, samples } = work;
  const parent: number[] = [-1];
  const fn: number[] = [tree.fn[0] ?? 0];
  const index = new Map<number, number>();
  const K = model.functions.length + work.synthetic.length + 1;
  const leafOf = new Int32Array(tree.length).fill(-1);
  const used = new Uint8Array(tree.length);
  for (let s = 0; s < samples.length; s++) used[samples.node[s] ?? 0] = 1;
  for (let n = 0; n < tree.length; n++) {
    if (!used[n]) continue;
    let at = 0;
    if (n === 0) {
      leafOf[0] = 0;
      continue;
    }
    for (let a = n; a > 0; a = tree.parent[a] ?? 0) {
      const f = tree.fn[a] ?? 0;
      const key = at * K + f;
      let child = index.get(key);
      if (child === undefined) {
        child = parent.length;
        parent.push(at);
        fn.push(f);
        index.set(key, child);
      }
      at = child;
    }
    leafOf[n] = at;
  }
  const count = samples.length;
  const node = new Uint32Array(count);
  const tmp = new Float64Array(parent.length);
  for (let s = 0; s < count; s++) {
    const target = leafOf[samples.node[s] ?? 0] ?? 0;
    node[s] = target;
    tmp[target] = (tmp[target] ?? 0) + (samples.dur[s] ?? 0);
  }
  const out = finish(work, parent, fn, samples.time, samples.dur, node, tmp);
  return { ...out, inverted: true };
}

function applyOne(model: ExecutionModel, work: Working, t: Transform): Working {
  const { tree, samples } = work;
  const F = model.functions.length;
  switch (t.kind) {
    case 'merge-function': {
      const fnOf = identityFns(tree);
      for (let i = 1; i < tree.length; i++) if (tree.fn[i] === t.fn) fnOf[i] = -1;
      return rebuild(model, work, { fnOf });
    }
    case 'merge-node': {
      const node = findNode(tree, t.path);
      const fnOf = identityFns(tree);
      if (node > 0) fnOf[node] = -1;
      return rebuild(model, work, { fnOf });
    }
    case 'focus-subtree': {
      const node = findNode(tree, t.path);
      if (node < 0)
        return rebuild(model, work, {
          fnOf: identityFns(tree),
          keepLeaf: new Uint8Array(tree.length),
        });
      const fnOf = identityFns(tree);
      const keepLeaf = new Uint8Array(tree.length);
      for (let i = 1; i < node; i++) {
        // Ancestors fold into the root; their own samples are dropped below.
        if (i < node && (tree.subtreeEnd[i] ?? 0) > node) fnOf[i] = -1;
      }
      for (let i = node; i < (tree.subtreeEnd[node] ?? 0); i++) keepLeaf[i] = 1;
      return rebuild(model, work, { fnOf, keepLeaf });
    }
    case 'focus-function': {
      const under = underFunction(tree, t.fn);
      const fnOf = identityFns(tree);
      for (let i = 1; i < tree.length; i++) if (!under[i]) fnOf[i] = -1;
      return rebuild(model, work, { fnOf, keepLeaf: under });
    }
    case 'focus-function-self': {
      const keepLeaf = new Uint8Array(tree.length);
      for (let i = 1; i < tree.length; i++) keepLeaf[i] = tree.fn[i] === t.fn ? 1 : 0;
      return rebuild(model, work, { fnOf: identityFns(tree), keepLeaf });
    }
    case 'collapse-package': {
      const synth = syntheticFor(model, work, t.pkg);
      const fnOf = identityFns(tree);
      for (let i = 1; i < tree.length; i++) {
        if (packageOf(model, work, tree.fn[i] ?? 0) === t.pkg) fnOf[i] = synth;
      }
      return rebuild(model, work, { fnOf, foldSynthetic: synth });
    }
    case 'collapse-dependencies': {
      const fnOf = identityFns(tree);
      for (let i = 1; i < tree.length; i++) {
        const f = tree.fn[i] ?? 0;
        if (f >= F) continue;
        const origin = model.functions.origin[f] ?? 0;
        const pkg = model.strings[model.functions.pkg[f] ?? 0] ?? '';
        if ((origin === Origin.Dependency || origin === Origin.Framework) && pkg !== '') {
          fnOf[i] = syntheticFor(model, work, pkg);
        }
      }
      return rebuild(model, work, { fnOf, foldSynthetic: F });
    }
    case 'collapse-recursion': {
      return rebuild(model, work, { fnOf: identityFns(tree), recurse: t.fn });
    }
    case 'drop-samples': {
      const under = underFunction(tree, t.fn);
      const keepLeaf = new Uint8Array(tree.length);
      for (let i = 0; i < tree.length; i++) keepLeaf[i] = under[i] ? 0 : 1;
      return rebuild(model, work, { fnOf: identityFns(tree), keepLeaf });
    }
    case 'time-range': {
      return rebuild(model, work, {
        fnOf: identityFns(tree),
        keepSample: (i) => (samples.time[i] ?? 0) >= t.start && (samples.time[i] ?? 0) < t.end,
      });
    }
    case 'invert':
      return work.inverted ? work : invert(model, work);
    case 'merge-plumbing': {
      const fnOf = identityFns(tree);
      for (let i = 1; i < tree.length; i++) {
        const f = tree.fn[i] ?? 0;
        if (f < F && model.functions.plumbing[f] === 1) fnOf[i] = -1;
      }
      return rebuild(model, work, { fnOf });
    }
    case 'drop-idle': {
      const keepLeaf = new Uint8Array(tree.length).fill(1);
      for (let i = 1; i < tree.length; i++) {
        const f = tree.fn[i] ?? 0;
        if (f < F && model.functions.origin[f] === Origin.Idle) keepLeaf[i] = 0;
      }
      return rebuild(model, work, { fnOf: identityFns(tree), keepLeaf });
    }
  }
}

/**
 * Time-ordered and per-function views only make sense on the call-order tree: an inverted view is
 * rebuilt from the same stack without its `invert` step.
 */
export function withoutInversion(model: ExecutionModel, view: TransformedView): TransformedView {
  if (!view.inverted) return view;
  return applyTransforms(
    model,
    view.trackIndex,
    view.stack.filter((t) => t.kind !== 'invert'),
  );
}

export function applyTransforms(
  model: ExecutionModel,
  trackIndex: number,
  stack: readonly Transform[],
): TransformedView {
  const track = model.tracks[trackIndex];
  if (!track)
    throw new Error(`No track at index ${trackIndex}; the model has ${model.tracks.length}.`);
  let work: Working = {
    tree: track.callTree,
    samples: track.samples,
    inverted: false,
    synthetic: [],
  };
  for (const t of stack) work = applyOne(model, work, t);
  const totalUs = work.tree.total[0] ?? 0;
  return {
    trackIndex,
    stack,
    tree: work.tree,
    samples: work.samples,
    inverted: work.inverted,
    totalUs,
    syntheticPackages: work.synthetic,
  };
}
