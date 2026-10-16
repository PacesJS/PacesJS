import type { ExecutionModel } from '@pacesjs/engine';
import { fnLocation } from './access';
import type { FlameData } from './flame';
import { viewFnName } from './tview';
import type { TView } from './tview';

/** Identity of a call path across two runs: function names and locations, root first. */
export function pathKeys(model: ExecutionModel, t: TView): string[] {
  const keys = new Array<string>(t.length);
  for (let i = 0; i < t.length; i++) {
    const f = t.fn[i] ?? 0;
    const own = `${viewFnName(model, t, f)}|${f < t.fnCount ? fnLocation(model, f) : ''}`;
    const p = t.parent[i] ?? -1;
    keys[i] = p >= 0 ? `${keys[p]}\u0001${own}` : own;
  }
  return keys;
}

/**
 * Differential flame graph: width stays the newer run's, `delta` is the change in share of the
 * run between baseline and now, scaled to -1 (faster) .. +1 (slower) by the largest change.
 */
export function withDelta(
  data: FlameData,
  nowKeys: string[],
  nowRootUs: number,
  baseKeys: string[],
  baseTotals: Float64Array,
  baseRootUs: number,
): FlameData {
  const base = new Map<string, number>();
  for (let i = 0; i < baseKeys.length; i++)
    base.set(baseKeys[i] as string, (baseTotals[i] ?? 0) / (baseRootUs || 1));
  const delta = new Float32Array(data.length);
  let max = 1e-9;
  for (let i = 0; i < data.length; i++) {
    const node = data.node[i] ?? -1;
    if (node < 0) continue;
    const now = (data.totalUs[i] ?? 0) / (nowRootUs || 1);
    const was = base.get(nowKeys[node] as string) ?? 0;
    const d = now - was;
    delta[i] = d;
    max = Math.max(max, Math.abs(d));
  }
  for (let i = 0; i < delta.length; i++) delta[i] = (delta[i] ?? 0) / max;
  return { ...data, delta };
}
