// Differential mode (v1.x): match functions between two models by a stable key, never by
// minified positions: project-relative original path, function name and original line.

import { Origin } from './model.js';
import type { ExecutionModel } from './model.js';
import type { DiffFunction, ModelDiff } from './query/types.js';
import { compareText } from './util/compare.js';

/** Share-of-busy-time change below this counts as unchanged (0.5 percentage points). */
export const DIFF_EPSILON = 0.005;

export function functionKey(model: ExecutionModel, fn: number): string {
  const f = model.functions;
  const file = model.strings[f.file[fn] ?? 0] ?? '';
  const name = model.strings[f.name[fn] ?? 0] ?? '';
  return `${file}|${name}|${f.line[fn] ?? 0}`;
}

interface Totals {
  name: string;
  file: string;
  line: number;
  fn: number;
  self: number;
  total: number;
}

function collect(model: ExecutionModel): {
  byKey: Map<string, Totals>;
  keyOf: string[];
  busy: number;
} {
  const byKey = new Map<string, Totals>();
  const keyOf: string[] = [];
  let busy = 0;
  for (let fn = 0; fn < model.functions.length; fn++) {
    keyOf.push(functionKey(model, fn));
  }
  for (const track of model.tracks) {
    busy += track.busyUs;
    track.fnIds.forEach((fn, i) => {
      if (model.functions.origin[fn] === Origin.Idle) return;
      const key = keyOf[fn] ?? '';
      const entry = byKey.get(key) ?? {
        name: model.strings[model.functions.name[fn] ?? 0] ?? '',
        file: model.strings[model.functions.file[fn] ?? 0] ?? '',
        line: model.functions.line[fn] ?? 0,
        fn,
        self: 0,
        total: 0,
      };
      entry.self += track.agg.fnSelf[i] ?? 0;
      entry.total += track.agg.fnTotal[i] ?? 0;
      entry.fn = Math.min(entry.fn, fn);
      byKey.set(key, entry);
    });
  }
  return { byKey, keyOf, busy };
}

export function diffModels(base: ExecutionModel, head: ExecutionModel): ModelDiff {
  const b = collect(base);
  const h = collect(head);
  const keys = [...new Set([...b.byKey.keys(), ...h.byKey.keys()])];
  const functions: DiffFunction[] = keys.map((key) => {
    const before = b.byKey.get(key);
    const after = h.byKey.get(key);
    const shown = after ?? before;
    const baseShare = before && b.busy > 0 ? before.self / b.busy : 0;
    const headShare = after && h.busy > 0 ? after.self / h.busy : 0;
    return {
      key,
      name: shown?.name ?? '',
      file: shown?.file ?? '',
      line: shown?.line ?? 0,
      baseFn: before ? before.fn : -1,
      headFn: after ? after.fn : -1,
      baseSelfUs: before?.self ?? 0,
      headSelfUs: after?.self ?? 0,
      baseTotalUs: before?.total ?? 0,
      headTotalUs: after?.total ?? 0,
      selfShareDelta: headShare - baseShare,
    };
  });
  functions.sort(
    (x, y) => Math.abs(y.selfShareDelta) - Math.abs(x.selfShareDelta) || compareText(x.key, y.key),
  );

  const byKey = new Map(functions.map((f) => [f.key, f]));
  const headSelfShareDelta = new Float64Array(head.functions.length);
  const headChange = new Int8Array(head.functions.length);
  for (let fn = 0; fn < head.functions.length; fn++) {
    const entry = byKey.get(h.keyOf[fn] ?? '');
    if (!entry) continue;
    headSelfShareDelta[fn] = entry.selfShareDelta;
    if (entry.baseFn < 0) headChange[fn] = 2;
    else if (entry.selfShareDelta > DIFF_EPSILON) headChange[fn] = 1;
    else if (entry.selfShareDelta < -DIFF_EPSILON) headChange[fn] = -1;
  }
  return { functions, headSelfShareDelta, headChange, baseBusyUs: b.busy, headBusyUs: h.busy };
}
