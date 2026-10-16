// Pass 5: reconstruct calls from samples. Consecutive samples that share a call path become spans.
// Precision is plus or minus one sampling interval: a span starts at its first sample and ends
// where the next sample begins.

import { Origin } from '../model.js';
import type { CallTree, Samples, SpanTable } from '../model.js';

export interface SpanInput {
  tree: CallTree;
  samples: Samples;
  /** Per function id. */
  origin: Uint8Array;
  /** A gap between samples above this closes every open span (microseconds). */
  gapUs: number;
}

export function reconstructSpans(input: SpanInput): SpanTable {
  const { tree, samples, origin, gapUs } = input;
  const node: number[] = [];
  const fn: number[] = [];
  const start: number[] = [];
  const end: number[] = [];
  const depth: number[] = [];
  const parent: number[] = [];

  const openNode: number[] = [];
  const openSpan: number[] = [];
  let bridged = false;
  const path: number[] = [];
  let lastEnd = 0;

  const closeTo = (keep: number): void => {
    while (openNode.length > keep) {
      openNode.pop();
      const s = openSpan.pop() ?? 0;
      end[s] = lastEnd;
    }
  };

  for (let i = 0; i < samples.length; i++) {
    const t = samples.time[i] ?? 0;
    const leaf = samples.node[i] ?? 0;
    if (openNode.length > 0 && t - lastEnd > gapUs) closeTo(0);

    path.length = 0;
    for (let n = leaf; n > 0; n = tree.parent[n] ?? 0) path.push(n);
    path.reverse();

    const leafFn = tree.fn[leaf] ?? 0;
    const topOrigin = openNode.length > 0 ? (origin[tree.fn[openNode[0] ?? 0] ?? 0] ?? 0) : -1;
    const isGc = (origin[leafFn] ?? 0) === Origin.Gc && path.length === 1;
    let bridgedNow = false;
    if (isGc && openNode.length > 0 && topOrigin !== Origin.Idle && topOrigin !== Origin.Gc) {
      // Bridge GC over the running stack so a pause does not split the call it interrupted.
      const base = bridged ? openNode.length - 1 : openNode.length;
      path.length = 0;
      for (let k = 0; k < base; k++) path.push(openNode[k] ?? 0);
      path.push(leaf);
      bridgedNow = true;
    }

    let common = 0;
    while (common < path.length && common < openNode.length && path[common] === openNode[common]) {
      common++;
    }
    closeTo(common);
    for (let d = common; d < path.length; d++) {
      const n = path[d] ?? 0;
      const index = node.length;
      node.push(n);
      fn.push(tree.fn[n] ?? 0);
      start.push(t);
      end.push(t);
      depth.push(d);
      parent.push(d === 0 ? -1 : (openSpan[d - 1] ?? -1));
      openNode.push(n);
      openSpan.push(index);
    }
    bridged = bridgedNow;
    lastEnd = t + (samples.dur[i] ?? 0);
  }
  closeTo(0);

  return {
    length: node.length,
    node: Uint32Array.from(node),
    fn: Uint32Array.from(fn),
    start: Float64Array.from(start),
    end: Float64Array.from(end),
    depth: Uint16Array.from(depth),
    parent: Int32Array.from(parent),
  };
}
