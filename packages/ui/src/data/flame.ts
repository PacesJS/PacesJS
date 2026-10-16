import type { ExecutionModel } from '@pacesjs/engine';
import type { FlameColor, FlameSort } from '../state/types';
import { at, fnLocation } from './access';
import { childrenOf, isPlaceholder, viewFnName, viewFnOrigin } from './tview';
import type { TView } from './tview';

export const MIN_FRAME_FRACTION = 0.0002;

/** Columnar frames for the canvas. x and w are fractions of the zoomed root's total. */
export interface FlameData {
  length: number;
  /** Transformed call node, or -1 for the synthetic "all samples" root. */
  node: Int32Array;
  depth: Uint16Array;
  x: Float64Array;
  w: Float64Array;
  fn: Uint32Array;
  origin: Uint8Array;
  /** Self time as a fraction of the largest self time (for the by-self-time color). */
  heat: Float32Array;
  totalUs: Float64Array;
  selfUs: Float64Array;
  /** Differential mode: change in share of the run per frame, -1 (faster) to +1 (slower). */
  delta?: Float32Array;
  /** Display name and location per frame. */
  names: string[];
  locs: string[];
  rootUs: number;
  maxDepth: number;
  /** Zoom breadcrumb: label per step after "All samples". */
  crumbs: Array<{ node: number; name: string }>;
}

export interface FlameOptions {
  sort: FlameSort;
  color: FlameColor;
  /** Transformed call node ids, outermost first. */
  zoom: number[];
}

export function flameData(model: ExecutionModel, t: TView, opts: FlameOptions): FlameData {
  const zoomNode = opts.zoom.length > 0 ? (opts.zoom[opts.zoom.length - 1] as number) : -1;
  const valid = zoomNode < t.length;
  const root = valid ? zoomNode : -1;
  const rootUs = root >= 0 ? (t.total[root] ?? 0) : t.keptUs;
  const denom = rootUs || 1;

  let maxSelf = 0;
  for (let i = 0; i < t.length; i++) maxSelf = Math.max(maxSelf, t.self[i] ?? 0);

  const node: number[] = [];
  const depth: number[] = [];
  const x: number[] = [];
  const w: number[] = [];
  const fn: number[] = [];
  const origin: number[] = [];
  const heat: number[] = [];
  const totalUs: number[] = [];
  const selfUs: number[] = [];
  const names: string[] = [];
  const locs: string[] = [];
  let maxDepth = 0;

  const push = (n: number, d: number, x0: number, width: number): void => {
    node.push(n);
    depth.push(d);
    x.push(x0);
    w.push(width);
    const f = n >= 0 ? (t.fn[n] ?? 0) : 0;
    fn.push(f);
    origin.push(n >= 0 ? viewFnOrigin(model, t, f) : 4);
    heat.push(n >= 0 && maxSelf > 0 ? (t.self[n] ?? 0) / maxSelf : 0);
    totalUs.push(n >= 0 ? (t.total[n] ?? 0) : rootUs);
    selfUs.push(n >= 0 ? (t.self[n] ?? 0) : 0);
    names.push(n >= 0 ? viewFnName(model, t, f) : 'all samples');
    locs.push(n >= 0 && !isPlaceholder(t, f) ? fnLocation(model, f) : '');
    maxDepth = Math.max(maxDepth, d);
  };

  const sorted = (list: number[]): number[] =>
    opts.sort === 'alpha'
      ? list
          .slice()
          .sort(
            (a, b) =>
              viewFnName(model, t, t.fn[a] ?? 0).localeCompare(
                viewFnName(model, t, t.fn[b] ?? 0),
              ) || a - b,
          )
      : list;

  const walk = (n: number, d: number, x0: number): void => {
    const width = (t.total[n] ?? 0) / denom;
    if (width < MIN_FRAME_FRACTION) return;
    push(n, d, x0, width);
    let cx = x0;
    for (const c of sorted(childrenOf(t, n))) {
      walk(c, d + 1, cx);
      cx += (t.total[c] ?? 0) / denom;
    }
  };

  if (root >= 0) {
    walk(root, 0, 0);
  } else {
    push(-1, 0, 0, 1);
    let cx = 0;
    for (const r of sorted(childrenOf(t, -1))) {
      walk(r, 1, cx);
      cx += (t.total[r] ?? 0) / denom;
    }
  }

  return {
    length: node.length,
    node: Int32Array.from(node),
    depth: Uint16Array.from(depth),
    x: Float64Array.from(x),
    w: Float64Array.from(w),
    fn: Uint32Array.from(fn),
    origin: Uint8Array.from(origin),
    heat: Float32Array.from(heat),
    totalUs: Float64Array.from(totalUs),
    selfUs: Float64Array.from(selfUs),
    names,
    locs,
    rootUs,
    maxDepth,
    crumbs: valid
      ? opts.zoom
          .filter((n) => n < t.length)
          .map((n) => ({ node: n, name: viewFnName(model, t, at(t.fn, n)) }))
      : [],
  };
}

/** Frame under a point (fractions x in [0,1], depth row) or -1. */
export function frameAt(d: FlameData, x: number, depth: number): number {
  for (let i = 0; i < d.length; i++) {
    if (d.depth[i] === depth && x >= (d.x[i] ?? 0) && x <= (d.x[i] ?? 0) + (d.w[i] ?? 0)) return i;
  }
  return -1;
}
