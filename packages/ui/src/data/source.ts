import type { ExecutionModel, Track } from '@pacesjs/engine';
import { at, fnLocation, relativePath, str } from './access';

export const SPARK_BINS = 40;

export interface SourceInfo {
  fn: number;
  /** Project-relative path to read through the host, or '' for functions without a file. */
  path: string;
  /** 1-based line where the function starts. */
  startLine: number;
  /** Self time per source line, microseconds, sorted by line. */
  lineSelf: Array<{ line: number; selfUs: number }>;
  hottestLine: number;
  /** Activity per time bin across the run, 0..1 relative to the busiest bin. */
  spark: number[];
  sparkTrack: string;
  durationUs: number;
  /** A source map was expected but missing: generated code is shown. */
  mapMissing: boolean;
  mapped: boolean;
  loc: string;
}

export function sourceInfo(model: ExecutionModel, tracks: Track[], fn: number): SourceInfo | null {
  if (fn < 0 || fn >= model.functions.length) return null;
  const file = str(model, at(model.functions.file, fn));
  const lines = new Map<number, number>();
  for (const track of tracks) {
    const lo = at(track.lines.offset, fn);
    const hi = at(track.lines.offset, fn + 1);
    for (let i = lo; i < hi; i++) {
      const line = at(track.lines.line, i);
      lines.set(line, (lines.get(line) ?? 0) + at(track.lines.self, i));
    }
  }
  const lineSelf = [...lines.entries()]
    .map(([line, selfUs]) => ({ line, selfUs }))
    .sort((a, b) => a.line - b.line);
  let hottest = at(model.functions.line, fn);
  let best = -1;
  for (const l of lineSelf) {
    if (l.selfUs > best) {
      best = l.selfUs;
      hottest = l.line;
    }
  }

  const primary = tracks[0];
  const spark = new Array<number>(SPARK_BINS).fill(0);
  let durationUs = 1;
  if (primary) {
    durationUs = Math.max(1, primary.durationUs);
    const ct = primary.callTree;
    const contains = new Uint8Array(ct.length);
    for (let n = 0; n < ct.length; n++) {
      const p = ct.parent[n] ?? -1;
      contains[n] = at(ct.fn, n) === fn || (p >= 0 && contains[p] === 1) ? 1 : 0;
    }
    const s = primary.samples;
    for (let i = 0; i < s.length; i++) {
      if (contains[at(s.node, i)] !== 1) continue;
      const b = Math.min(SPARK_BINS - 1, Math.floor((at(s.time, i) / durationUs) * SPARK_BINS));
      spark[b] = (spark[b] ?? 0) + 1;
    }
    const max = Math.max(1, ...spark);
    for (let b = 0; b < SPARK_BINS; b++) spark[b] = (spark[b] ?? 0) / max;
  }

  return {
    fn,
    path: file ? relativePath(file, model.meta.projectRoot) : '',
    startLine: at(model.functions.line, fn),
    lineSelf,
    hottestLine: hottest,
    spark,
    sparkTrack: primary?.label ?? '',
    durationUs,
    mapMissing: at(model.functions.mapMissing, fn) === 1,
    mapped: at(model.functions.mapped, fn) === 1,
    loc: fnLocation(model, fn),
  };
}

export interface CallSiteChip {
  /** 0-based index into the lines array. */
  lineIndex: number;
  fn: number | null;
  name: string;
  totalUs: number;
  origin: number;
}

/**
 * Heuristic call-site chips: the model records time per callee but not the calling line, so a
 * callee is pinned to the first line that textually calls it. Labelled as such in the UI.
 */
export function matchCallSites(
  lines: string[],
  callees: Array<{ fn: number | null; name: string; totalUs: number; origin: number }>,
): CallSiteChip[] {
  const out: CallSiteChip[] = [];
  const used = new Set<number>();
  for (const c of callees) {
    const bare = (c.name.split('▸').pop() ?? c.name).trim();
    const token = bare.split('.').pop() ?? bare;
    if (!/^[A-Za-z_$][\w$]*$/.test(token)) continue;
    const re = new RegExp(`\\b${token.replace(/\$/g, '\\$')}\\s*\\(`);
    const idx = lines.findIndex(
      (l, i) => !used.has(i) && re.test(l.replace(/^\s*(export\s+)?(async\s+)?function\s+\w+/, '')),
    );
    if (idx >= 0) {
      used.add(idx);
      out.push({ lineIndex: idx, fn: c.fn, name: c.name, totalUs: c.totalUs, origin: c.origin });
    }
  }
  return out;
}
