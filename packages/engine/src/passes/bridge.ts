// Pass 1b: bridge runtime samples. V8 reports `(program)` (native time with no JS stack) and
// `(garbage collector)` as root children, so a call that is really continuous looks like several
// calls split by a root-level sample. When such a run of samples sits between two samples whose
// stacks share a prefix, it is re-attached as a leaf child of the deepest shared frame, as in a
// waterfall where a GC pause is a child of the running call. Only the parent of those samples
// changes: sample count, durations and every total are preserved. `(idle)` stays a boundary.

import { depthsOf, preorder, subtreeEnds, totalsOf } from '../util/tree-columns.js';
import type { IngestedTrack, IngestResult, RawTicks, RawTree } from './types.js';

const TRANSPARENT = new Set(['(program)', '(garbage collector)']);

function rebuild(
  track: IngestedTrack,
  extraParent: number[],
  extraFrame: number[],
  sampleNode: Uint32Array,
  transparentOld: Uint8Array,
): IngestedTrack {
  const old = track.tree;
  const L = old.length;
  const total = L + extraParent.length;
  const parent = new Int32Array(total);
  const frame = new Uint32Array(total);
  parent.set(old.parent);
  frame.set(old.frame);
  extraParent.forEach((p, i) => {
    parent[L + i] = p;
    frame[L + i] = extraFrame[i] ?? 0;
  });
  const hits = new Uint32Array(total);
  for (let i = 0; i < sampleNode.length; i++) {
    const n = sampleNode[i] ?? 0;
    hits[n] = (hits[n] ?? 0) + 1;
  }

  const kids: number[][] = Array.from({ length: total }, () => []);
  for (let n = 1; n < total; n++) {
    const keep = !(n < L && transparentOld[n] === 1 && (hits[n] ?? 0) === 0);
    if (keep) kids[parent[n] ?? 0]?.push(n);
  }
  const order = preorder(kids);
  const length = order.length;
  const newId = new Int32Array(total).fill(-1);
  order.forEach((n, i) => {
    newId[n] = i;
  });
  const tParent = new Int32Array(length);
  const tFrame = new Uint32Array(length);
  const tSelf = new Float64Array(length);
  const tHits = new Uint32Array(length);
  for (let i = 0; i < length; i++) {
    const n = order[i] ?? 0;
    tFrame[i] = frame[n] ?? 0;
    tHits[i] = hits[n] ?? 0;
    const p = i === 0 ? -1 : (newId[parent[n] ?? 0] ?? 0);
    tParent[i] = p;
  }
  const samples = track.samples;
  const nodes = new Uint32Array(samples.length);
  for (let s = 0; s < samples.length; s++) {
    const i = newId[sampleNode[s] ?? 0] ?? 0;
    nodes[s] = i;
    tSelf[i] = (tSelf[i] ?? 0) + (samples.dur[s] ?? 0);
  }

  // Line ticks follow their nodes; added nodes have none.
  const offset = new Uint32Array(length + 1);
  const lines: number[] = [];
  const ticks: number[] = [];
  for (let i = 0; i < length; i++) {
    offset[i] = lines.length;
    const n = order[i] ?? 0;
    if (n < L) {
      for (let k = track.ticks.offset[n] ?? 0; k < (track.ticks.offset[n + 1] ?? 0); k++) {
        lines.push(track.ticks.line[k] ?? 0);
        ticks.push(track.ticks.ticks[k] ?? 0);
      }
    }
  }
  offset[length] = lines.length;
  const rawTicks: RawTicks = {
    offset,
    line: Uint32Array.from(lines),
    ticks: Uint32Array.from(ticks),
  };
  const tree: RawTree = {
    length,
    parent: tParent,
    frame: tFrame,
    depth: depthsOf(tParent),
    subtreeEnd: subtreeEnds(tParent),
    self: tSelf,
    total: totalsOf(tParent, tSelf),
    hits: tHits,
  };
  return {
    ...track,
    tree,
    ticks: rawTicks,
    samples: { length: samples.length, time: samples.time, node: nodes, dur: samples.dur },
  };
}

function bridgeTrack(track: IngestedTrack, names: string[], frameName: Uint32Array): IngestedTrack {
  const { tree, samples } = track;
  const nameOf = (node: number): string => names[frameName[tree.frame[node] ?? 0] ?? 0] ?? '';
  const transparent = new Uint8Array(tree.length);
  let any = false;
  for (let n = 1; n < tree.length; n++) {
    if (tree.parent[n] === 0 && (tree.subtreeEnd[n] ?? 0) === n + 1 && TRANSPARENT.has(nameOf(n))) {
      transparent[n] = 1;
      any = true;
    }
  }
  if (!any || samples.length === 0) return track;

  const lca = (a: number, b: number): number => {
    let x = a;
    let y = b;
    while (x !== y) {
      if ((tree.depth[x] ?? 0) >= (tree.depth[y] ?? 0)) x = tree.parent[x] ?? 0;
      else y = tree.parent[y] ?? 0;
    }
    return x;
  };
  const isIdle = (node: number): boolean => nameOf(node) === '(idle)';

  const sampleNode = Uint32Array.from(samples.node);
  const extraParent: number[] = [];
  const extraFrame: number[] = [];
  const created = new Map<number, number>();
  const K = frameName.length + 1;
  const existing = new Map<number, number>();
  for (let n = 1; n < tree.length; n++) {
    existing.set((tree.parent[n] ?? 0) * K + (tree.frame[n] ?? 0), n);
  }
  let changed = false;
  for (let i = 0; i < samples.length;) {
    if (transparent[samples.node[i] ?? 0] !== 1) {
      i++;
      continue;
    }
    let j = i;
    while (j < samples.length && transparent[samples.node[j] ?? 0] === 1) j++;
    const before = i > 0 ? (samples.node[i - 1] ?? 0) : -1;
    const after = j < samples.length ? (samples.node[j] ?? 0) : -1;
    if (before >= 0 && after >= 0 && !isIdle(before) && !isIdle(after)) {
      const shared = lca(before, after);
      if (shared > 0) {
        for (let k = i; k < j; k++) {
          const frame = tree.frame[samples.node[k] ?? 0] ?? 0;
          const key = shared * K + frame;
          let id = existing.get(key) ?? created.get(key);
          if (id === undefined) {
            id = tree.length + extraParent.length;
            extraParent.push(shared);
            extraFrame.push(frame);
            created.set(key, id);
          }
          sampleNode[k] = id;
          changed = true;
        }
      }
    }
    i = j;
  }
  if (!changed) return track;
  return rebuild(track, extraParent, extraFrame, sampleNode, transparent);
}

export function bridgeRuntimeSamples(ingest: IngestResult, strings: string[]): IngestResult {
  return {
    ...ingest,
    tracks: ingest.tracks.map((t) => bridgeTrack(t, strings, ingest.frames.name)),
  };
}
