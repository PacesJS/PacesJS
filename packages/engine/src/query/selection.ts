// Selection helpers: for a hover or selection, which ids light up in each view.

import type { ExecutionModel } from '../model.js';
import type { RelatedIds, Selection, TransformedView } from './types.js';
import { findNode } from './view.js';
import { taskOfSpan } from '../util/search.js';

const TOP_TASK_FNS = 5;

function subtree(view: TransformedView, node: number): number[] {
  const out: number[] = [];
  for (let i = node; i < (view.tree.subtreeEnd[node] ?? 0); i++) out.push(i);
  return out;
}

function empty(): RelatedIds {
  return { fns: [], nodes: [], spans: [], tasks: [], range: null };
}

export function relatedIds(
  model: ExecutionModel,
  view: TransformedView,
  selection: Selection,
): RelatedIds {
  const track = model.tracks[view.trackIndex];
  const out = empty();
  switch (selection.kind) {
    case 'function': {
      out.fns = [selection.fn];
      for (let i = 0; i < view.tree.length; i++)
        if (view.tree.fn[i] === selection.fn) out.nodes.push(i);
      if (track) {
        const tasks = new Set<number>();
        for (let s = 0; s < track.spans.length; s++) {
          if (track.spans.fn[s] !== selection.fn) continue;
          out.spans.push(s);
          const k = taskOfSpan(track.tasks, s);
          if (k >= 0) tasks.add(k);
        }
        out.tasks = [...tasks].sort((a, b) => a - b);
      }
      return out;
    }
    case 'node': {
      const node = findNode(view.tree, selection.path);
      if (node < 0) return out;
      out.fns = [view.tree.fn[node] ?? 0];
      out.nodes = subtree(view, node);
      return out;
    }
    case 'span': {
      const t = model.tracks[selection.trackIndex];
      if (!t || selection.span < 0 || selection.span >= t.spans.length) return out;
      const s = selection.span;
      out.fns = [t.spans.fn[s] ?? 0];
      out.spans = [s];
      const k = taskOfSpan(t.tasks, s);
      if (k >= 0) out.tasks = [k];
      if (selection.trackIndex === view.trackIndex) {
        const path: number[] = [];
        for (let p = s; p >= 0; p = t.spans.parent[p] ?? -1) path.push(t.spans.fn[p] ?? 0);
        const node = findNode(view.tree, path.reverse());
        if (node >= 0) out.nodes = [node];
      }
      return out;
    }
    case 'task': {
      const t = model.tracks[selection.trackIndex];
      if (!t || selection.task < 0 || selection.task >= t.tasks.length) return out;
      const k = selection.task;
      out.tasks = [k];
      out.range = [t.tasks.start[k] ?? 0, t.tasks.end[k] ?? 0];
      const acc = new Map<number, number>();
      for (let i = 0; i < t.samples.length; i++) {
        const time = t.samples.time[i] ?? 0;
        if (time < out.range[0]) continue;
        if (time >= out.range[1]) break;
        const fn = t.callTree.fn[t.samples.node[i] ?? 0] ?? 0;
        acc.set(fn, (acc.get(fn) ?? 0) + (t.samples.dur[i] ?? 0));
      }
      out.fns = [...acc.entries()]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .slice(0, TOP_TASK_FNS)
        .map(([fn]) => fn);
      for (let s = t.tasks.spanStart[k] ?? 0; s < (t.tasks.spanEnd[k] ?? 0); s++) out.spans.push(s);
      return out;
    }
    case 'range': {
      out.range = [selection.start, selection.end];
      if (track) {
        for (let k = 0; k < track.tasks.length; k++) {
          if (
            (track.tasks.end[k] ?? 0) > selection.start &&
            (track.tasks.start[k] ?? 0) < selection.end
          ) {
            out.tasks.push(k);
          }
        }
      }
      return out;
    }
  }
}

export const hoverRelated = relatedIds;
