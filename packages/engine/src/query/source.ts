// Per-function source info for the docked source panel: line self time, callee chips, sparkline.

import type { ExecutionModel } from '../model.js';
import { Origin } from '../model.js';
import { addCoverage, capAtOne } from '../util/buckets.js';
import { formatDuration, plural } from '../util/format.js';
import type {
  CalleeTime,
  CallSite,
  FunctionSourceInfo,
  LineInfo,
  LineSelf,
  TransformedView,
  ViewFnId,
} from './types.js';
import { describeFunction, withoutInversion } from './view.js';

const SPARK_BUCKETS = 60;

function describeLines(
  model: ExecutionModel,
  info: ReturnType<typeof describeFunction>,
  lines: LineSelf[],
  hottest: number,
  selfUs: number,
  totalUs: number,
  callees: number,
): LineInfo {
  if (lines.length > 0) {
    return {
      status: 'self-lines',
      reason: `${lines.length} ${plural(lines.length, 'line has', 'lines have')} self time; the hottest is line ${hottest}.`,
    };
  }
  if (info.synthetic) {
    return {
      status: 'no-line-data',
      reason: 'A collapsed package covers many files, so it has no single source to show lines in.',
    };
  }
  const native = info.file === '' || info.origin === Origin.Native;
  if (native) {
    return { status: 'no-line-data', reason: 'Native or runtime code has no source file to show.' };
  }
  const little = selfUs < Math.max(2 * model.meta.precisionUs, 0.05 * totalUs);
  if (little && callees > 0) {
    return {
      status: 'no-self-time',
      reason: `The function's own code ran for ${formatDuration(selfUs)} of ${formatDuration(totalUs)}; the rest is in ${callees} ${plural(callees, 'callee', 'callees')} (see callee time).`,
    };
  }
  return {
    status: 'no-line-data',
    reason: `V8 recorded no line positions for this function although it ran for ${formatDuration(selfUs)} (for example because it was inlined).`,
  };
}

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
  const callees = new Map<ViewFnId, { us: number; self: number; calls: number }>();
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
      const entry = callees.get(callee) ?? { us: 0, self: 0, calls: 0 };
      entry.us += tree.total[i] ?? 0;
      entry.self += tree.self[i] ?? 0;
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

  const calleeTime: CalleeTime[] = [...callees.entries()]
    .map(([callee, v]) => {
      const c = describeFunction(model, callee, view.syntheticPackages);
      return { fn: callee, name: c.name, pkg: c.pkg, selfUs: v.self, totalUs: v.us };
    })
    .sort((x, y) => y.totalUs - x.totalUs || x.fn - y.fn);
  const hotLines = lines
    .filter((l) => l.selfUs > 0)
    .sort((x, y) => y.selfUs - x.selfUs || x.line - y.line)
    .slice(0, 8);
  const lineInfo = describeLines(
    model,
    info,
    lines,
    hottestLine,
    selfUs,
    totalUs,
    calleeTime.length,
  );

  const sparkline = new Float32Array(SPARK_BUCKETS);
  const end = Math.max(1, track ? model.meta.durationUs : 1);
  const width = end / SPARK_BUCKETS;
  const s = view.samples;
  for (let i = 0; i < s.length; i++) {
    if (contains[s.node[i] ?? 0] !== 1) continue;
    const a = s.time[i] ?? 0;
    addCoverage(sparkline, a, a + (s.dur[i] ?? 0), 0, width);
  }
  capAtOne(sparkline);

  return {
    fn,
    name: info.name,
    file: info.file,
    line: info.line,
    definitionLine: info.synthetic ? 0 : info.line,
    selfUs,
    totalUs,
    lines,
    hottestLine,
    hotLines,
    callSites,
    calleeTime,
    lineInfo,
    sparkline,
    mapMissing: info.mapMissing,
  };
}
