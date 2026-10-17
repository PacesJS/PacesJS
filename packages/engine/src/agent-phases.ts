// Phases of a run for the agent summary: what the primary track was doing, in time order.

import { Origin } from './model.js';
import { functionName } from './frames.js';
import type { ExecutionModel, FnId, Track } from './model.js';
import { ms, share } from './util/format.js';
import { displayPath } from './util/paths.js';

export interface SourceLocation {
  name: string;
  /** Project-relative original path, or a node: URL for runtime internals. */
  file: string;
  line: number;
}

export interface AgentPhase {
  /** `startup · module loading`, `config loading`, `module loading`, `main work` or `waiting`. */
  name: string;
  startMs: number;
  durationMs: number;
  busyMs: number;
  /** Share of the primary track's busy time. */
  share: number;
  /** Functions with the most self time in the phase. */
  hottest: Array<SourceLocation & { selfMs: number }>;
}

const PHASE_BUCKETS = 60;
/** A stretch shorter than this share of the run is folded into its neighbour. */
const MIN_PHASE_SHARE = 0.03;
/** Code about configuration, on the stack under a module load, makes it "config loading". */
const CONFIG_HINT = /config/i;
const CAT_WORK = 0;
const CAT_LOAD = 1;
const CAT_CONFIG = 2;
const CAT_IDLE = 3;
const CATEGORIES = 4;

interface Run {
  cat: number;
  from: number;
  to: number;
}

/** Merges neighbours of equal category. */
function coalesce(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && last.cat === r.cat) last.to = r.to;
    else out.push({ ...r });
  }
  return out;
}

/** The category of each call node: idle, module loading, config loading, or work. */
function categoryOfNodes(model: ExecutionModel, track: Track): Uint8Array {
  const tree = track.callTree;
  const f = model.functions;
  const loadAnc = new Uint8Array(tree.length);
  const configAnc = new Uint8Array(tree.length);
  for (let n = 1; n < tree.length; n++) {
    const p = tree.parent[n] ?? 0;
    const fn = tree.fn[n] ?? 0;
    const text = `${functionName(model, fn)} ${model.strings[f.file[fn] ?? 0] ?? ''}`;
    const plain =
      f.loader[fn] !== 1 && f.origin[fn] !== Origin.Native && f.origin[fn] !== Origin.Node;
    loadAnc[n] = (loadAnc[p] ?? 0) | (f.loader[fn] ?? 0);
    configAnc[n] = (configAnc[p] ?? 0) | (plain && CONFIG_HINT.test(text) ? 1 : 0);
  }
  const cat = new Uint8Array(tree.length);
  for (let n = 0; n < tree.length; n++) {
    if (f.origin[tree.fn[n] ?? 0] === Origin.Idle) cat[n] = CAT_IDLE;
    else if (loadAnc[n] === 1) cat[n] = configAnc[n] === 1 ? CAT_CONFIG : CAT_LOAD;
    else cat[n] = CAT_WORK;
  }
  return cat;
}

/** One run per time bucket, labelled with the category that weighs the most in it (idle on ties). */
function bucketRuns(track: Track, cat: Uint8Array, t0: number, width: number): Run[] {
  const s = track.samples;
  const weight = new Float64Array(PHASE_BUCKETS * CATEGORIES);
  for (let i = 0; i < s.length; i++) {
    const b = Math.min(PHASE_BUCKETS - 1, Math.floor(((s.time[i] ?? 0) - t0) / width));
    const k = b * CATEGORIES + (cat[s.node[i] ?? 0] ?? CAT_WORK);
    weight[k] = (weight[k] ?? 0) + (s.dur[i] ?? 0);
  }
  const runs: Run[] = [];
  for (let b = 0; b < PHASE_BUCKETS; b++) {
    let best = CAT_IDLE;
    let bestWeight = weight[b * CATEGORIES + CAT_IDLE] ?? 0;
    for (const c of [CAT_WORK, CAT_LOAD, CAT_CONFIG]) {
      if ((weight[b * CATEGORIES + c] ?? 0) > bestWeight) {
        best = c;
        bestWeight = weight[b * CATEGORIES + c] ?? 0;
      }
    }
    runs.push({ cat: best, from: b, to: b + 1 });
  }
  return coalesce(runs);
}

/** Folds short runs into the longer neighbour until none is left. */
function foldShortRuns(input: Run[]): Run[] {
  let runs = input;
  const minLen = Math.max(1, Math.round(PHASE_BUCKETS * MIN_PHASE_SHARE));
  while (runs.length > 1) {
    const i = runs.findIndex((r) => r.to - r.from < minLen);
    const run = runs[i];
    if (!run) break;
    const prev = runs[i - 1];
    const next = runs[i + 1];
    const into =
      prev && next ? (prev.to - prev.from >= next.to - next.from ? prev : next) : (prev ?? next);
    if (!into) break;
    into.from = Math.min(into.from, run.from);
    into.to = Math.max(into.to, run.to);
    runs.splice(i, 1);
    runs = coalesce(runs);
  }
  return runs;
}

const PHASE_NAMES: Record<number, string> = {
  [CAT_CONFIG]: 'config loading',
  [CAT_IDLE]: 'waiting',
};

function phaseName(cat: number, index: number): string {
  if (cat === CAT_LOAD) return index === 0 ? 'startup · module loading' : 'module loading';
  return PHASE_NAMES[cat] ?? 'main work';
}

/** What a phase did between `start` and `end`: busy time and the functions with the most self time. */
function describePhase(
  model: ExecutionModel,
  track: Track,
  range: { start: number; end: number },
  busyTotal: number,
  name: string,
): AgentPhase {
  const { start, end } = range;
  const s = track.samples;
  const tree = track.callTree;
  const f = model.functions;
  const self = new Map<FnId, number>();
  let busy = 0;
  for (let i = 0; i < s.length; i++) {
    const at = s.time[i] ?? 0;
    if (at < start || at >= end) continue;
    const fn = tree.fn[s.node[i] ?? 0] ?? 0;
    if (f.origin[fn] === Origin.Idle) continue;
    busy += s.dur[i] ?? 0;
    if (f.origin[fn] !== Origin.Gc && f.plumbing[fn] !== 1) {
      self.set(fn, (self.get(fn) ?? 0) + (s.dur[i] ?? 0));
    }
  }
  const hottest = [...self.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 3)
    .map(([fn, us]) => ({
      name: functionName(model, fn) || '(anonymous)',
      file: displayPath(model.strings[f.file[fn] ?? 0] ?? ''),
      line: f.line[fn] ?? 0,
      selfMs: ms(us),
    }));
  return {
    name,
    startMs: ms(start),
    durationMs: ms(end - start),
    busyMs: ms(busy),
    share: share(busy / busyTotal),
    hottest,
  };
}

/**
 * Phases of the primary track, by what its samples were doing: loading modules (and, when code
 * about configuration is on the stack, loading config), computing, or waiting.
 */
export function phasesOf(model: ExecutionModel, busyTotal: number): AgentPhase[] {
  const track = model.tracks[model.primaryTrack];
  if (!track || track.samples.length === 0) return [];
  const s = track.samples;
  const t0 = s.time[0] ?? 0;
  const t1 = (s.time[s.length - 1] ?? 0) + (s.dur[s.length - 1] ?? 0);
  const width = Math.max(1, (t1 - t0) / PHASE_BUCKETS);
  const runs = foldShortRuns(bucketRuns(track, categoryOfNodes(model, track), t0, width));
  return runs.map((run, index) =>
    describePhase(
      model,
      track,
      { start: t0 + run.from * width, end: Math.min(t1, t0 + run.to * width) },
      busyTotal,
      phaseName(run.cat, index),
    ),
  );
}
