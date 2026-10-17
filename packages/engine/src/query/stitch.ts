// The `stitch-continuations` transform: re-roots the stacks of resumed async functions under the
// parent path of the call they continue, and puts every stack under one root named after the entry
// script. Reads the continuation table the analysis produced; allocates per distinct (task, node),
// not per sample.

import { isRuntimeFn } from '../frames.js';
import type { CallTree, ExecutionModel, Samples } from '../model.js';
import { taskOfSpan } from '../util/search.js';
import { createTreeBuilder } from './tree-builder.js';

export interface StitchPlan {
  /** Creation-order tree: parent index per node (node 0 is the `(root)`). */
  parent: number[];
  fn: number[];
  /** New node of each input sample. */
  node: Uint32Array;
}

export function stitchPlan(
  model: ExecutionModel,
  trackIndex: number,
  tree: CallTree,
  samples: Samples,
  K: number,
): StitchPlan | undefined {
  const track = model.tracks[trackIndex];
  if (!track || tree !== track.callTree) return undefined;
  const { spans, tasks, continuations } = track;
  const program = (fn: number): boolean => !isRuntimeFn(model.functions, fn);

  const { parent, fn, child } = createTreeBuilder(tree.fn[0] ?? 0, K);
  const entry = child(0, track.rootFn);

  // Identity placement (everything under the entry root) and the shallowest program frame of each node.
  const place = new Uint32Array(tree.length);
  const anchor = new Int32Array(tree.length).fill(-1);
  for (let n = 1; n < tree.length; n++) {
    const p = tree.parent[n] ?? 0;
    place[n] = child(p === 0 ? entry : (place[p] ?? 0), tree.fn[n] ?? 0);
    const above = p > 0 ? (anchor[p] ?? -1) : -1;
    anchor[n] = above >= 0 ? above : program(tree.fn[n] ?? 0) ? n : -1;
  }

  // Stitched segments by (task, resumed function).
  const rowOf = new Map<number, number>();
  for (let r = 0; r < continuations.length; r++) {
    rowOf.set((continuations.task[r] ?? 0) * K + (continuations.fn[r] ?? 0), r);
  }

  const baseMemo = new Map<number, number>();
  const graftMemo = new Map<number, number>();
  const segmentOf = (k: number, node: number): number => {
    const a = anchor[node] ?? -1;
    return k < 0 || a < 0 ? -1 : (rowOf.get(k * K + (tree.fn[a] ?? 0)) ?? -1);
  };
  const base = (r: number): number => {
    const known = baseMemo.get(r);
    if (known !== undefined) return known;
    const p = continuations.parentSpan[r] ?? -1;
    // The parent span is earlier than the task, so this recursion ends.
    const out = p < 0 ? entry : nodeOfSpan(p);
    baseMemo.set(r, out);
    return out;
  };
  const graft = (r: number, node: number): number => {
    const key = r * tree.length + node;
    const known = graftMemo.get(key);
    if (known !== undefined) return known;
    const a = anchor[node] ?? 0;
    const out =
      node === a
        ? child(base(r), tree.fn[node] ?? 0)
        : child(graft(r, tree.parent[node] ?? 0), tree.fn[node] ?? 0);
    graftMemo.set(key, out);
    return out;
  };
  const nodeOfSpan = (span: number): number => {
    const node = spans.node[span] ?? 0;
    const r = segmentOf(taskOfSpan(tasks, span), node);
    return r >= 0 ? graft(r, node) : (place[node] ?? 0);
  };

  const out = new Uint32Array(samples.length);
  let k = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = samples.time[i] ?? 0;
    while (k < tasks.length && (tasks.end[k] ?? 0) <= t) k++;
    const leaf = samples.node[i] ?? 0;
    const inTask = k < tasks.length && (tasks.start[k] ?? 0) <= t;
    const r = inTask && leaf > 0 ? segmentOf(k, leaf) : -1;
    out[i] = leaf === 0 ? 0 : r >= 0 ? graft(r, leaf) : (place[leaf] ?? 0);
  }
  return { parent, fn, node: out };
}
