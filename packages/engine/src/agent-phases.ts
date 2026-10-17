// Phases of a run for the agent summary: what the primary track was doing, in time order.

import { Origin } from './model.js';
import { functionName } from './frames.js';
import type { ExecutionModel, FnId } from './model.js';
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

/**
 * Phases of the primary track, by what its samples were doing: loading modules (and, when code
 * about configuration is on the stack, loading config), computing, or waiting.
 */
export function phasesOf(model: ExecutionModel, busyTotal: number): AgentPhase[] {
  const track = model.tracks[model.primaryTrack];
  if (!track || track.samples.length === 0) return [];
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
  const catOf = (node: number): number => {
    if (f.origin[tree.fn[node] ?? 0] === Origin.Idle) return CAT_IDLE;
    if (loadAnc[node] === 1) return configAnc[node] === 1 ? CAT_CONFIG : CAT_LOAD;
    return CAT_WORK;
  };

  const s = track.samples;
  const t0 = s.time[0] ?? 0;
  const t1 = (s.time[s.length - 1] ?? 0) + (s.dur[s.length - 1] ?? 0);
  const width = Math.max(1, (t1 - t0) / PHASE_BUCKETS);
  const weight = new Float64Array(PHASE_BUCKETS * CATEGORIES);
  for (let i = 0; i < s.length; i++) {
    const b = Math.min(PHASE_BUCKETS - 1, Math.floor(((s.time[i] ?? 0) - t0) / width));
    const k = b * CATEGORIES + catOf(s.node[i] ?? 0);
    weight[k] = (weight[k] ?? 0) + (s.dur[i] ?? 0);
  }
  let runs: Run[] = [];
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
  runs = coalesce(runs);

  // Fold short runs into the longer neighbour until none is left.
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

  return runs.map((run, index): AgentPhase => {
    const start = t0 + run.from * width;
    const end = Math.min(t1, t0 + run.to * width);
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
    const name =
      run.cat === CAT_CONFIG
        ? 'config loading'
        : run.cat === CAT_LOAD
          ? index === 0
            ? 'startup · module loading'
            : 'module loading'
          : run.cat === CAT_IDLE
            ? 'waiting'
            : 'main work';
    return {
      name,
      startMs: ms(start),
      durationMs: ms(end - start),
      busyMs: ms(busy),
      share: share(busy / busyTotal),
      hottest,
    };
  });
}
