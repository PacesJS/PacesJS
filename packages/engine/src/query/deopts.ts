// Where V8 threw away optimized code, as marks on a view: a count per function for the bars and the
// lines of one function for the source panel.

import type { ExecutionModel } from '../model.js';
import type { DeoptSite, ViewFnId } from './types.js';

const KIND_NAMES = ['eager', 'lazy', 'soft', 'other'] as const;

// Not worth a mark: V8 swaps the running loop into optimized code and back as part of warming up.
const WARM_UP = new Set(["exit from OSR'd inner loop", 'prepare for on stack replacement (OSR)']);

/** A worker shares its process's trace, so its id (`p12-w1`) points at the process (`p12`). */
const processOf = (trackId: string): string => trackId.replace(/-w\d+$/, '');

/** Rows of the deopt table that belong to this track's process and are worth showing. */
function rowsOf(model: ExecutionModel, trackIndex: number): number[] {
  const track = model.tracks[trackIndex];
  if (!track) return [];
  const proc = processOf(track.id);
  const rows: number[] = [];
  const d = model.deopts;
  for (let i = 0; i < d.length; i++) {
    if (model.strings[d.proc[i] ?? 0] !== proc) continue;
    if (WARM_UP.has(model.strings[d.reason[i] ?? 0] ?? '')) continue;
    rows.push(i);
  }
  return rows;
}

/**
 * Deopts per view function id (model functions, then the collapsed packages in `synthetic`, which
 * add up their members).
 */
export function deoptCounts(
  model: ExecutionModel,
  trackIndex: number,
  synthetic: readonly string[],
): Uint32Array {
  const F = model.functions.length;
  const out = new Uint32Array(F + synthetic.length);
  const d = model.deopts;
  const packageOf = new Map(synthetic.map((p, i) => [p, F + i]));
  for (const i of rowsOf(model, trackIndex)) {
    const fn = d.fn[i] ?? 0;
    const count = d.count[i] ?? 0;
    out[fn] = (out[fn] ?? 0) + count;
    const pkg = packageOf.get(model.strings[model.functions.pkg[fn] ?? 0] ?? '');
    if (pkg !== undefined) out[pkg] = (out[pkg] ?? 0) + count;
  }
  return out;
}

/** The deopts of one function, most often first. */
export function deoptSites(model: ExecutionModel, trackIndex: number, fn: ViewFnId): DeoptSite[] {
  const d = model.deopts;
  return rowsOf(model, trackIndex)
    .filter((i) => d.fn[i] === fn)
    .map((i) => ({
      reason: model.strings[d.reason[i] ?? 0] ?? '',
      kind: KIND_NAMES[d.kind[i] ?? 3] ?? 'other',
      line: d.origLine[i] ?? 0,
      count: d.count[i] ?? 0,
    }))
    .sort((a, b) => b.count - a.count || a.line - b.line || (a.reason < b.reason ? -1 : 1));
}
