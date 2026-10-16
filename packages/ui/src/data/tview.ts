import type { ExecutionModel, Track } from '@pacesjs/engine';
import type { TimeRange, Transform } from '../state/types';
import { ORIGIN_DEP, ORIGIN_IDLE, at, fnName, packageOf } from './access';

/**
 * The transformed call tree of one or more tracks: the single structure every aggregate view reads.
 * Function ids below `fnCount` are model functions; ids from `fnCount` up are collapsed packages.
 */
export interface TView {
  fnCount: number;
  pkgNames: string[];
  length: number;
  parent: Int32Array;
  fn: Uint32Array;
  depth: Uint16Array;
  /** Preorder: the subtree of i is [i, subtreeEnd[i]). Children are ordered by total, heaviest first. */
  subtreeEnd: Uint32Array;
  self: Float64Array;
  total: Float64Array;
  /** Per track id: original call-tree node -> transformed node, or -1 when the sample was dropped. */
  origToT: Map<string, Int32Array>;
  /** Total time kept after transforms and range, microseconds. */
  keptUs: number;
  /** Whether the stack was inverted (self time sits at the roots). */
  inverted: boolean;
}

interface Frame {
  fn: number;
  node: number;
}

export interface TViewInput {
  model: ExecutionModel;
  tracks: Track[];
  transforms: readonly Transform[];
  range: TimeRange | null;
  /** Packages shown expanded even when dependencies are collapsed (call graph). */
  expandedPkgs?: readonly string[];
}

const pkgCache = new WeakMap<ExecutionModel, string[]>();

/** Every package name in the model, sorted: collapsed-package ids are stable across transforms. */
export function allPackages(model: ExecutionModel): string[] {
  let hit = pkgCache.get(model);
  if (!hit) {
    const set = new Set<string>();
    for (let f = 0; f < model.functions.length; f++) {
      const p = model.strings[at(model.functions.pkg, f)] ?? '';
      if (p) set.add(p);
    }
    hit = [...set].sort();
    pkgCache.set(model, hit);
  }
  return hit;
}

export function isPlaceholder(t: TView, fn: number): boolean {
  return fn >= t.fnCount;
}

export function viewFnName(model: ExecutionModel, t: TView, fn: number): string {
  if (fn < t.fnCount) return fnName(model, fn);
  return t.pkgNames[fn - t.fnCount] ?? '(package)';
}

export function viewFnOrigin(model: ExecutionModel, t: TView, fn: number): number {
  return fn < t.fnCount ? at(model.functions.origin, fn) : ORIGIN_DEP;
}

export function viewFnPkg(model: ExecutionModel, t: TView, fn: number): string {
  return fn < t.fnCount ? packageOf(model, fn) : (t.pkgNames[fn - t.fnCount] ?? '');
}

/** Time a sample stands for: the engine's per-sample duration. */
function sampleWeight(track: Track, i: number, intervalUs: number): number {
  return at(track.samples.dur, i) || intervalUs;
}

function lowerBoundTime(t: Float64Array, v: number): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (at(t, mid) < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Time attributed to each original call-tree node within the range (all time when no range). */
export function nodeWeights(
  track: Track,
  range: TimeRange | null,
  intervalUs: number,
): Float64Array {
  if (!range) return Float64Array.from(track.callTree.self);
  const w = new Float64Array(track.callTree.length);
  const times = track.samples.time;
  const lo = lowerBoundTime(times, range[0]);
  const hi = lowerBoundTime(times, range[1]);
  for (let i = lo; i < hi; i++) {
    const node = at(track.samples.node, i);
    w[node] = (w[node] ?? 0) + sampleWeight(track, i, intervalUs);
  }
  return w;
}

export function buildTView(input: TViewInput): TView {
  const { model, tracks, transforms, range } = input;
  const expanded = new Set(input.expandedPkgs ?? []);
  const fnCount = model.functions.length;
  const pkgNames = allPackages(model);
  const pkgIndex = new Map(pkgNames.map((p, i) => [p, i]));
  const placeholder = (pkg: string): number => fnCount + (pkgIndex.get(pkg) ?? 0);

  const origin = model.functions.origin;
  const plumbing = model.functions.plumbing;
  const invert = transforms.some((t) => t.k === 'invert');

  const pkgOfFrame = (f: number): string => {
    if (f >= fnCount) return pkgNames[f - fnCount] ?? '';
    return packageOf(model, f);
  };
  const originOfFrame = (f: number): number => (f >= fnCount ? ORIGIN_DEP : at(origin, f));

  /** Run the per-stack pipeline. Returns null when the sample is dropped. */
  function pipeline(path: Frame[], trackId: string): Frame[] | null {
    let p = path;
    for (const tr of transforms) {
      switch (tr.k) {
        case 'drop-idle':
          if (p.some((f) => originOfFrame(f.fn) === ORIGIN_IDLE)) return null;
          break;
        case 'merge-plumbing':
          p = p.filter((f) => f.fn >= fnCount || at(plumbing, f.fn) === 0);
          break;
        case 'merge-fn':
          p = p.filter((f) => f.fn !== tr.fn);
          break;
        case 'merge-node':
          if (tr.track === trackId) p = p.filter((f) => f.node !== tr.node);
          break;
        case 'drop-fn':
          if (p.some((f) => f.fn === tr.fn)) return null;
          break;
        case 'focus-fn': {
          const i = p.findIndex((f) => f.fn === tr.fn);
          if (i < 0) return null;
          p = p.slice(i);
          break;
        }
        case 'focus-self': {
          const last = p[p.length - 1];
          if (!last || last.fn !== tr.fn) return null;
          break;
        }
        case 'focus-node': {
          if (tr.track !== trackId) return null;
          const i = p.findIndex((f) => f.node === tr.node);
          if (i < 0) return null;
          p = p.slice(i);
          break;
        }
        case 'collapse-rec':
          p = p.filter((f, i) => !(f.fn === tr.fn && i > 0 && (p[i - 1] as Frame).fn === tr.fn));
          break;
        case 'collapse-pkg':
        case 'collapse-deps': {
          const wanted = (f: Frame): string => {
            const pkg = pkgOfFrame(f.fn);
            if (!pkg || expanded.has(pkg)) return '';
            if (tr.k === 'collapse-pkg') return tr.pkg === pkg ? pkg : '';
            return originOfFrame(f.fn) === ORIGIN_DEP ? pkg : '';
          };
          const out: Frame[] = [];
          for (const f of p) {
            const pkg = wanted(f);
            const prev = out[out.length - 1];
            if (pkg && prev && prev.fn === placeholder(pkg)) continue;
            out.push(pkg ? { fn: placeholder(pkg), node: f.node } : f);
          }
          p = out;
          break;
        }
        case 'invert':
          break;
      }
    }
    return p;
  }

  // Raw trie, insertion order (parents before children).
  const rawParent: number[] = [];
  const rawFn: number[] = [];
  const rawSelf: number[] = [];
  const key = new Map<number, number>();
  const stride = fnCount + model.strings.length + 1;
  const ensure = (parent: number, fn: number): number => {
    const k = (parent + 1) * stride + fn;
    let id = key.get(k);
    if (id === undefined) {
      id = rawParent.length;
      key.set(k, id);
      rawParent.push(parent);
      rawFn.push(fn);
      rawSelf.push(0);
    }
    return id;
  };

  const rawMaps = new Map<string, Int32Array>();
  const intervalUs = model.meta.intervalUs;
  for (const track of tracks) {
    const ct = track.callTree;
    const weights = nodeWeights(track, range, intervalUs);
    const map = new Int32Array(ct.length).fill(-1);
    const paths: Frame[][] = new Array<Frame[]>(ct.length);
    for (let n = 0; n < ct.length; n++) {
      const par = ct.parent[n] ?? -1;
      const base = par >= 0 ? (paths[par] as Frame[]) : [];
      paths[n] = [...base, { fn: at(ct.fn, n), node: n }];
    }
    for (let n = 0; n < ct.length; n++) {
      const w = at(weights, n);
      if (w <= 0) continue;
      let p = pipeline(paths[n] as Frame[], track.id);
      if (!p || p.length === 0) continue;
      if (invert) p = p.slice().reverse();
      let cur = -1;
      for (const f of p) cur = ensure(cur, f.fn);
      rawSelf[cur] = (rawSelf[cur] ?? 0) + w;
      map[n] = cur;
    }
    rawMaps.set(track.id, map);
  }

  const rawLen = rawParent.length;
  const rawTotal = Float64Array.from(rawSelf);
  for (let i = rawLen - 1; i >= 0; i--) {
    const p = rawParent[i] as number;
    if (p >= 0) rawTotal[p] = (rawTotal[p] ?? 0) + (rawTotal[i] ?? 0);
  }

  // Preorder with children sorted heaviest first (ties: name, then id) for a stable layout.
  const children: number[][] = Array.from({ length: rawLen }, () => []);
  const roots: number[] = [];
  for (let i = 0; i < rawLen; i++) {
    const p = rawParent[i] as number;
    if (p >= 0) (children[p] as number[]).push(i);
    else roots.push(i);
  }
  const nameOf = (raw: number): string => {
    const f = rawFn[raw] as number;
    return f < fnCount ? fnName(model, f) : (pkgNames[f - fnCount] ?? '');
  };
  const cmp = (a: number, b: number): number =>
    (rawTotal[b] ?? 0) - (rawTotal[a] ?? 0) || nameOf(a).localeCompare(nameOf(b)) || a - b;
  roots.sort(cmp);
  for (const c of children) c.sort(cmp);

  const order = new Int32Array(rawLen);
  const newId = new Int32Array(rawLen);
  const parent = new Int32Array(rawLen);
  const depth = new Uint16Array(rawLen);
  const subtreeEnd = new Uint32Array(rawLen);
  let next = 0;
  const stack: Array<[number, number]> = [];
  for (let r = roots.length - 1; r >= 0; r--) stack.push([roots[r] as number, -1]);
  while (stack.length > 0) {
    const [raw, par] = stack.pop() as [number, number];
    const id = next++;
    order[id] = raw;
    newId[raw] = id;
    parent[id] = par;
    depth[id] = par >= 0 ? (depth[par] ?? 0) + 1 : 0;
    const kids = children[raw] as number[];
    for (let k = kids.length - 1; k >= 0; k--) stack.push([kids[k] as number, id]);
  }
  for (let i = rawLen - 1; i >= 0; i--) {
    subtreeEnd[i] = Math.max(subtreeEnd[i] ?? 0, i + 1);
    const p = parent[i] ?? -1;
    if (p >= 0) subtreeEnd[p] = Math.max(subtreeEnd[p] ?? 0, subtreeEnd[i] ?? 0);
  }

  const fn = new Uint32Array(rawLen);
  const self = new Float64Array(rawLen);
  const total = new Float64Array(rawLen);
  for (let i = 0; i < rawLen; i++) {
    const raw = order[i] as number;
    fn[i] = rawFn[raw] as number;
    self[i] = rawSelf[raw] as number;
    total[i] = rawTotal[raw] as number;
  }
  const origToT = new Map<string, Int32Array>();
  for (const [id, m] of rawMaps) {
    const out = new Int32Array(m.length);
    for (let i = 0; i < m.length; i++) {
      const r = m[i] ?? -1;
      out[i] = r < 0 ? -1 : (newId[r] ?? -1);
    }
    origToT.set(id, out);
  }
  let keptUs = 0;
  for (const r of roots) keptUs += rawTotal[r] ?? 0;

  return {
    fnCount,
    pkgNames,
    length: rawLen,
    parent,
    fn,
    depth,
    subtreeEnd,
    self,
    total,
    origToT,
    keptUs,
    inverted: invert,
  };
}

/** Children of node i (or the roots for -1) in display order. */
export function childrenOf(t: TView, i: number): number[] {
  const out: number[] = [];
  let c = i + 1;
  const end = i < 0 ? t.length : (t.subtreeEnd[i] ?? i + 1);
  while (c < end) {
    out.push(c);
    c = t.subtreeEnd[c] ?? c + 1;
  }
  return out;
}

/** Time of a function as a union over its nodes: nodes under an ancestor of the same fn count once. */
export function functionTotals(t: TView): { self: Float64Array; total: Float64Array } {
  const n = t.fnCount + t.pkgNames.length;
  const self = new Float64Array(n);
  const total = new Float64Array(n);
  const open: number[] = [];
  const active = new Int32Array(n);
  for (let i = 0; i < t.length; i++) {
    while (open.length > 0 && (t.subtreeEnd[open[open.length - 1] as number] ?? 0) <= i) {
      const done = open.pop() as number;
      active[t.fn[done] as number] = (active[t.fn[done] as number] ?? 1) - 1;
    }
    const f = t.fn[i] as number;
    self[f] = (self[f] ?? 0) + (t.self[i] ?? 0);
    if ((active[f] ?? 0) === 0) total[f] = (total[f] ?? 0) + (t.total[i] ?? 0);
    active[f] = (active[f] ?? 0) + 1;
    open.push(i);
  }
  return { self, total };
}
