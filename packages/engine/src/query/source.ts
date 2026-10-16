// Per-function source info for the docked source panel: line self time, callee chips, sparkline.

import type { ExecutionModel } from '../model.js';
import type { CallSite, FunctionSourceInfo, LineSelf, TransformedView, ViewFnId } from './types.js';
import { describeFunction, withoutInversion } from './view.js';

const SPARK_BUCKETS = 60;

export function functionSource(
  model: ExecutionModel,
  inputView: TransformedView,
  fn: ViewFnId,
): FunctionSourceInfo {
  const view = withoutInversion(model, inputView);
  const info = describeFunction(model, fn, view.syntheticPackages);
  const track = model.tracks[view.trackIndex];
  const tree = view.tree;

  let selfUs = 0;
  let totalUs = 0;
  const contains = new Uint8Array(tree.length);
  const callees = new Map<ViewFnId, { us: number; calls: number }>();
  for (let i = 0; i < tree.length; i++) {
    const p = tree.parent[i] ?? -1;
    const inherited = p >= 0 ? (contains[p] ?? 0) : 0;
    const here = tree.fn[i] === fn;
    contains[i] = inherited === 1 || here ? 1 : 0;
    if (here) {
      selfUs += tree.self[i] ?? 0;
      if (inherited === 0) totalUs += tree.total[i] ?? 0;
    }
    // Callees: children of a node of this function. Recursion is not a call site of itself.
    if (p >= 0 && tree.fn[p] === fn && !here) {
      const callee = tree.fn[i] ?? 0;
      const entry = callees.get(callee) ?? { us: 0, calls: 0 };
      entry.us += tree.total[i] ?? 0;
      entry.calls += 1;
      callees.set(callee, entry);
    }
  }

  const lines: LineSelf[] = [];
  const F = model.functions.length;
  if (track && fn < F) {
    const a = track.lines.offset[fn] ?? 0;
    const b = track.lines.offset[fn + 1] ?? 0;
    let sum = 0;
    for (let i = a; i < b; i++) sum += track.lines.self[i] ?? 0;
    for (let i = a; i < b; i++) {
      const us = track.lines.self[i] ?? 0;
      lines.push({ line: track.lines.line[i] ?? 0, selfUs: us, share: sum > 0 ? us / sum : 0 });
    }
  }
  let hottestLine = info.line;
  let best = -1;
  for (const l of lines) {
    if (l.selfUs > best) {
      best = l.selfUs;
      hottestLine = l.line;
    }
  }

  // Sampled profiles carry no call-site line, so chips cannot be placed on a line: line is 0.
  const callSites: CallSite[] = [...callees.entries()]
    .map(([callee, v]) => ({ callee, line: 0, calleeUs: v.us, calls: v.calls }))
    .sort((x, y) => y.calleeUs - x.calleeUs || x.callee - y.callee);

  const sparkline = new Float32Array(SPARK_BUCKETS);
  const end = Math.max(1, track ? model.meta.durationUs : 1);
  const width = end / SPARK_BUCKETS;
  const s = view.samples;
  for (let i = 0; i < s.length; i++) {
    if (contains[s.node[i] ?? 0] !== 1) continue;
    const a = s.time[i] ?? 0;
    const b = a + (s.dur[i] ?? 0);
    for (let k = Math.max(0, Math.floor(a / width)); k < SPARK_BUCKETS; k++) {
      const lo = k * width;
      if (lo >= b) break;
      const overlap = Math.min(b, lo + width) - Math.max(a, lo);
      if (overlap > 0) sparkline[k] = (sparkline[k] ?? 0) + overlap / width;
    }
  }
  for (let k = 0; k < SPARK_BUCKETS; k++) sparkline[k] = Math.min(1, sparkline[k] ?? 0);

  return {
    fn,
    name: info.name,
    file: info.file,
    line: info.line,
    selfUs,
    totalUs,
    lines,
    hottestLine,
    callSites,
    sparkline,
    mapMissing: info.mapMissing,
  };
}
