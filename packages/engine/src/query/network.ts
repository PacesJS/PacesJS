// What the page fetched, joined to what the scripts it fetched then cost to run.

import { REQUEST_FLAG, REQUEST_TYPE_NAMES } from '../model.js';
import type { ExecutionModel, FnId } from '../model.js';

export interface ScriptCost {
  url: string;
  /** Requests for it; a script fetched by two frames counts twice. */
  requests: number;
  wireBytes: number;
  decodedBytes: number;
  /** From the request being sent to the body arriving, microseconds; -1 when unknown. */
  downloadUs: number;
  renderBlocking: boolean;
  cached: boolean;
  /** Main-thread time spent in its functions, microseconds (sampled). */
  selfUs: number;
  functions: number;
}

export interface NetworkOverview {
  requests: number;
  wireBytes: number;
  decodedBytes: number;
  byType: Array<{ type: string; count: number; wireBytes: number }>;
}

const known = (n: number): number => (n < 0 ? 0 : n);

/** Scripts the page fetched, the ones that ran the most first. Scripts that never ran are included. */
export function scriptCosts(model: ExecutionModel): ScriptCost[] {
  const t = model.page?.requests;
  if (!t) return [];
  const byUrl = new Map<string, ScriptCost>();
  for (let i = 0; i < t.length; i++) {
    if (REQUEST_TYPE_NAMES[t.type[i] ?? 0] !== 'Script') continue;
    const url = model.strings[t.url[i] ?? 0] ?? '';
    const flags = t.flags[i] ?? 0;
    const end = t.end[i] ?? -1;
    const cost = byUrl.get(url) ?? {
      url,
      requests: 0,
      wireBytes: 0,
      decodedBytes: 0,
      downloadUs: -1,
      renderBlocking: false,
      cached: true,
      selfUs: 0,
      functions: 0,
    };
    cost.requests++;
    cost.wireBytes += known(t.encoded[i] ?? -1);
    cost.decodedBytes += known(t.decoded[i] ?? -1);
    if (end >= 0) cost.downloadUs = Math.max(cost.downloadUs, end - (t.start[i] ?? 0));
    cost.renderBlocking ||= (flags & REQUEST_FLAG.renderBlocking) !== 0;
    cost.cached &&= (flags & REQUEST_FLAG.cached) !== 0;
    byUrl.set(url, cost);
  }
  const strings = model.strings;
  for (const track of model.tracks) {
    for (let k = 0; k < track.fnIds.length; k++) {
      const fn = track.fnIds[k] ?? 0;
      const cost = byUrl.get(strings[model.functions.script[fn] ?? 0] ?? '');
      if (!cost) continue;
      cost.selfUs += track.agg.fnSelf[k] ?? 0;
      cost.functions++;
    }
  }
  return [...byUrl.values()].sort(
    (a, b) => b.selfUs - a.selfUs || b.wireBytes - a.wireBytes || a.url.localeCompare(b.url),
  );
}

export function networkOverview(model: ExecutionModel): NetworkOverview {
  const t = model.page?.requests;
  const empty: NetworkOverview = { requests: 0, wireBytes: 0, decodedBytes: 0, byType: [] };
  if (!t) return empty;
  const byType = new Map<string, { count: number; wireBytes: number }>();
  let wire = 0;
  let decoded = 0;
  for (let i = 0; i < t.length; i++) {
    const type = REQUEST_TYPE_NAMES[t.type[i] ?? 0] ?? 'Other';
    const entry = byType.get(type) ?? { count: 0, wireBytes: 0 };
    entry.count++;
    entry.wireBytes += known(t.encoded[i] ?? -1);
    byType.set(type, entry);
    wire += known(t.encoded[i] ?? -1);
    decoded += known(t.decoded[i] ?? -1);
  }
  return {
    requests: t.length,
    wireBytes: wire,
    decodedBytes: decoded,
    byType: [...byType]
      .map(([type, v]) => ({ type, ...v }))
      .sort((a, b) => b.wireBytes - a.wireBytes || a.type.localeCompare(b.type)),
  };
}

const costsByUrl = new WeakMap<ExecutionModel, Map<string, ScriptCost>>();

/** What the file that `fn` was parsed from cost to fetch and to run, or null when it was not fetched as a script. */
export function scriptCostFor(model: ExecutionModel, fn: FnId): ScriptCost | null {
  if (fn < 0 || fn >= model.functions.length) return null;
  let byUrl = costsByUrl.get(model);
  if (!byUrl) {
    byUrl = new Map(scriptCosts(model).map((c) => [c.url, c]));
    costsByUrl.set(model, byUrl);
  }
  return byUrl.get(model.strings[model.functions.script[fn] ?? 0] ?? '') ?? null;
}
