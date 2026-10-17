// Pass 9: rule-based findings. Each rule is a pure function of the finished model and the
// thresholds; the thresholds are echoed in the finding's `rule` text so users can see why it fired.

import { DEFAULT_SUPPRESS_FOR_CLI } from '../config.js';
import type { Thresholds } from '../config.js';
import { Origin, TASK_KIND_NAMES, TaskKind } from '../model.js';
import { functionName } from '../frames.js';
import type { ExecutionModel, Finding, FindingKind, FnId, Severity, Track } from '../model.js';
import { hotPaths } from '../query/paths.js';
import { compareText } from '../util/compare.js';
import { formatDuration, formatPercent, plural } from '../util/format.js';
import { displayPath } from '../util/paths.js';
import type { PassContext } from './types.js';
import { lowerBound } from '../util/search.js';

type Rule = (model: ExecutionModel, th: Thresholds) => Finding[];

const KIND_ORDER: FindingKind[] = [
  'event-loop-blocked',
  'sync-io',
  'hot-function',
  'hot-path',
  'hot-dependency',
  'gc-pressure',
  'async-overhead',
  'heavy-serialization',
  'late-module-loading',
  'event-loop-lag',
];
const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

const SYNC_FILES = /^node:(fs|child_process|zlib|crypto|internal\/(fs|child_process|crypto)\/)/;
const SYNC_NAME = /Sync$/;
const JSON_NAME = /^(JSON\.)?(parse|stringify)$/;

const text = (m: ExecutionModel, id: number): string => m.strings[id] ?? '';
const fnName = (m: ExecutionModel, fn: FnId): string => functionName(m, fn) || '(anonymous)';
const fnFile = (m: ExecutionModel, fn: FnId): string => text(m, m.functions.file[fn] ?? 0);
/** `name (file:line)`: enough to open the function. */
const place = (m: ExecutionModel, fn: FnId): string =>
  `${displayPath(fnFile(m, fn)) || 'unknown'}:${m.functions.line[fn] ?? 0}`;
const where = (m: ExecutionModel, fn: FnId): string => `${fnName(m, fn)} (${place(m, fn)})`;
const isTargetTrack = (m: ExecutionModel, ti: number): boolean => m.tracks[ti]?.role === 'target';
const originOf = (m: ExecutionModel, fn: FnId): number => m.functions.origin[fn] ?? Origin.User;

function taskRange(track: Track, k: number): [number, number] {
  return [
    lowerBound(track.samples.time, track.tasks.start[k] ?? 0),
    lowerBound(track.samples.time, track.tasks.end[k] ?? 0),
  ];
}

function isSteadyTask(track: Track, k: number): boolean {
  return (track.tasks.kind[k] ?? TaskKind.Other) !== TaskKind.Main;
}

/** Busy time (microseconds) of all tasks outside startup, for every track. */
function steadyBusy(m: ExecutionModel): number {
  let total = 0;
  m.tracks.forEach((t, ti) => {
    if (!isTargetTrack(m, ti)) return;
    for (let k = 0; k < t.tasks.length; k++) if (isSteadyTask(t, k)) total += t.tasks.busy[k] ?? 0;
  });
  return total;
}

function totalBusy(m: ExecutionModel): number {
  return m.tracks.reduce((n, t, ti) => n + (isTargetTrack(m, ti) ? t.busyUs : 0), 0);
}

/** The `track` field of a finding or its `showMe`, omitted when the track is gone. */
function trackRef(track: Track | undefined): { track?: string } {
  return track ? { track: track.id } : {};
}

function severityBy(value: number, high: number, medium: number): Severity {
  return value >= high ? 'high' : value >= medium ? 'medium' : 'low';
}

/** Leaf function with the most self time inside a task, optionally filtered. */
function topFnInTask(
  m: ExecutionModel,
  track: Track,
  k: number,
  accept: (fn: FnId) => boolean,
): FnId | undefined {
  const acc = new Map<FnId, number>();
  const [a, b] = taskRange(track, k);
  for (let i = a; i < b; i++) {
    const fn = track.callTree.fn[track.samples.node[i] ?? 0] ?? 0;
    if (originOf(m, fn) !== Origin.Idle && accept(fn)) {
      acc.set(fn, (acc.get(fn) ?? 0) + (track.samples.dur[i] ?? 0));
    }
  }
  let best: FnId | undefined;
  let bestV = -1;
  for (const [fn, v] of acc) {
    if (v > bestV || (v === bestV && best !== undefined && fn < best)) {
      best = fn;
      bestV = v;
    }
  }
  return best;
}

/** Nearest ancestor-or-self of `node` that is non-plumbing user code. */
function userCaller(m: ExecutionModel, track: Track, node: number): FnId | undefined {
  for (let n = node; n > 0; n = track.callTree.parent[n] ?? 0) {
    const fn = track.callTree.fn[n] ?? 0;
    if (originOf(m, fn) === Origin.User && m.functions.plumbing[fn] !== 1) return fn;
  }
  return undefined;
}

function hottestLine(m: ExecutionModel, track: Track, fn: FnId): number {
  const a = track.lines.offset[fn] ?? 0;
  const b = track.lines.offset[fn + 1] ?? 0;
  let line = m.functions.line[fn] ?? 0;
  let best = -1;
  for (let i = a; i < b; i++) {
    if ((track.lines.self[i] ?? 0) > best) {
      best = track.lines.self[i] ?? 0;
      line = track.lines.line[i] ?? line;
    }
  }
  return line;
}

// ---- Rules ----

const eventLoopBlocked: Rule = (m, th) => {
  const limit = th.longTaskMs * 1000;
  const long: Array<{ track: number; task: number; dur: number }> = [];
  m.tracks.forEach((t, ti) => {
    if (!isTargetTrack(m, ti)) return;
    for (let k = 0; k < t.tasks.length; k++) {
      const dur = (t.tasks.end[k] ?? 0) - (t.tasks.start[k] ?? 0);
      if (isSteadyTask(t, k) && dur > limit) long.push({ track: ti, task: k, dur });
    }
  });
  if (long.length === 0) return [];
  long.sort((a, b) => b.dur - a.dur || a.track - b.track || a.task - b.task);
  const worst = long[0];
  const track = worst ? m.tracks[worst.track] : undefined;
  if (!worst || !track) return [];
  const sum = long.reduce((n, x) => n + x.dur, 0);
  const wall = m.tracks.reduce((n, t, ti) => n + (isTargetTrack(m, ti) ? t.durationUs : 0), 0) || 1;
  const top = topFnInTask(m, track, worst.task, (fn) => m.functions.plumbing[fn] !== 1);
  const culprit = top === undefined ? '' : ` Most of it ran in ${where(m, top)}.`;
  return [
    {
      id: `event-loop-blocked:${track.id}`,
      kind: 'event-loop-blocked',
      severity: severityBy(worst.dur, 250_000, 100_000),
      title: 'Event loop blocked',
      summary: `${long.length} ${plural(long.length, 'task', 'tasks')} ran longer than ${th.longTaskMs} ms; the worst held the event loop for ${formatDuration(worst.dur)}.${culprit}`,
      rule: `Any task longer than ${th.longTaskMs} ms, not counting startup (main) tasks.`,
      impact: Math.min(1, sum / wall),
      showMe: {
        view: 'waterfall',
        track: track.id,
        task: worst.task,
        options: { criticalPath: true },
      },
      evidence: top === undefined ? [] : [top],
      track: track.id,
    },
  ];
};

const syncIo: Rule = (m, th) => {
  interface Hit {
    us: number;
    track: number;
    node: number;
    task: number;
    taskUs: number;
  }
  const byFn = new Map<FnId, Hit>();
  let denominator = 0;
  m.tracks.forEach((t, ti) => {
    if (!isTargetTrack(m, ti)) return;
    const tree = t.callTree;
    // Outermost synchronous API frame above each node, skipping module loading (reported on its own).
    const anchor = new Int32Array(tree.length).fill(-1);
    const loading = new Uint8Array(tree.length);
    for (let n = 1; n < tree.length; n++) {
      const p = tree.parent[n] ?? 0;
      const fn = tree.fn[n] ?? 0;
      const file = fnFile(m, fn);
      loading[n] = (loading[p] ?? 0) === 1 || file.startsWith('node:internal/modules/') ? 1 : 0;
      const inherited = anchor[p] ?? -1;
      if (inherited >= 0) anchor[n] = inherited;
      else if (!loading[n] && SYNC_NAME.test(fnName(m, fn)) && SYNC_FILES.test(file)) anchor[n] = n;
    }
    for (let k = 0; k < t.tasks.length; k++) {
      const kind = t.tasks.kind[k];
      if (kind !== TaskKind.Request && kind !== TaskKind.Timer) continue;
      denominator += t.tasks.busy[k] ?? 0;
      const perTask = new Map<number, number>();
      const [a, b] = taskRange(t, k);
      for (let i = a; i < b; i++) {
        const node = anchor[t.samples.node[i] ?? 0] ?? -1;
        if (node < 0) continue;
        perTask.set(node, (perTask.get(node) ?? 0) + (t.samples.dur[i] ?? 0));
      }
      for (const [node, us] of perTask) {
        const fn = tree.fn[node] ?? 0;
        const hit = byFn.get(fn) ?? { us: 0, track: ti, node, task: k, taskUs: 0 };
        hit.us += us;
        if (us > hit.taskUs) {
          hit.taskUs = us;
          hit.track = ti;
          hit.node = node;
          hit.task = k;
        }
        byFn.set(fn, hit);
      }
    }
  });
  const total = [...byFn.values()].reduce((n, h) => n + h.us, 0);
  if (total < th.syncIoMinMs * 1000 || byFn.size === 0) return [];
  const ranked = [...byFn.entries()].sort((a, b) => b[1].us - a[1].us || a[0] - b[0]);
  const [fn, hit] = ranked[0] ?? [0, undefined];
  const track = hit ? m.tracks[hit.track] : undefined;
  if (!hit || !track) return [];
  const share = denominator > 0 ? total / denominator : 0;
  const caller = userCaller(m, track, hit.node);
  const module = fnFile(m, fn).slice('node:'.length).split('/')[0] ?? '';
  const api = `${module}.${fnName(m, fn)}`;
  return [
    {
      id: `sync-io:${track.id}:${fn}`,
      kind: 'sync-io',
      severity: severityBy(share, 0.25, 0.1),
      title: 'Synchronous I/O on a hot path',
      summary: `${api} runs synchronously inside request and timer tasks: ${formatDuration(total)} in total (${formatPercent(share)} of their time)${caller === undefined ? '' : `, called from ${where(m, caller)}`}.`,
      rule: `fs, child_process, zlib or crypto *Sync call inside a request or timer task, at least ${th.syncIoMinMs} ms in total.`,
      impact: Math.min(1, share),
      showMe: {
        view: 'waterfall',
        track: track.id,
        task: hit.task,
        fn: caller ?? fn,
        ...(caller === undefined ? {} : { line: hottestLine(m, track, caller) }),
      },
      evidence: caller === undefined ? [fn] : [fn, caller],
      track: track.id,
    },
  ];
};

/** Self time of a user function, counting the native frames it calls (regex, builtins) as its own. */
function effectiveUserSelf(m: ExecutionModel): Map<FnId, { us: number; track: number }> {
  const perTrack = new Map<FnId, number[]>();
  m.tracks.forEach((t, ti) => {
    if (!isTargetTrack(m, ti)) return;
    const tree = t.callTree;
    const target = new Int32Array(tree.length).fill(-1);
    for (let n = 1; n < tree.length; n++) {
      const fn = tree.fn[n] ?? 0;
      const o = originOf(m, fn);
      if (o === Origin.User && m.functions.plumbing[fn] !== 1) target[n] = fn;
      else if (o === Origin.Native && fnName(m, fn) !== '(program)') {
        target[n] = target[tree.parent[n] ?? 0] ?? -1;
      }
      const into = target[n] ?? -1;
      if (into < 0 || (tree.self[n] ?? 0) === 0) continue;
      const list = perTrack.get(into) ?? new Array<number>(m.tracks.length).fill(0);
      list[ti] = (list[ti] ?? 0) + (tree.self[n] ?? 0);
      perTrack.set(into, list);
    }
  });
  const out = new Map<FnId, { us: number; track: number }>();
  for (const [fn, list] of perTrack) {
    let best = 0;
    list.forEach((v, i) => {
      if (v > (list[best] ?? 0)) best = i;
    });
    out.set(fn, { us: list.reduce((a, b) => a + b, 0), track: best });
  }
  return out;
}

const hotFunction: Rule = (m, th) => {
  const busy = totalBusy(m);
  if (busy / m.meta.precisionUs < th.minSamples) return [];
  const found = [...effectiveUserSelf(m).entries()]
    .filter(([, v]) => v.us / busy > th.hotFunctionShare)
    .sort((a, b) => b[1].us - a[1].us || a[0] - b[0])
    .slice(0, 3);
  return found.flatMap(([fn, v]): Finding[] => {
    const track = m.tracks[v.track];
    if (!track) return [];
    const share = v.us / busy;
    return [
      {
        id: `hot-function:${fn}`,
        kind: 'hot-function',
        severity: severityBy(share, 0.4, 0.2),
        title: 'Hot function',
        summary: `${where(m, fn)} takes ${formatPercent(share)} of all CPU time (${formatDuration(v.us)} of its own work).`,
        rule: `A user function above ${formatPercent(th.hotFunctionShare)} of busy time; native frames it calls (regex, builtins) count as its own.`,
        impact: Math.min(1, share),
        showMe: {
          view: 'functions',
          track: track.id,
          fn,
          line: hottestLine(m, track, fn),
        },
        evidence: [fn],
        track: track.id,
      },
    ];
  });
};

const hotDependency: Rule = (m, th) => {
  // A server's startup is not its steady state; a command has nothing but startup.
  const server = m.meta.runKind === 'server';
  const base = server ? steadyBusy(m) : totalBusy(m);
  if (base / m.meta.precisionUs < th.minSamples) return [];
  // The target is what is being profiled, so its own package is never a finding.
  const targetPkgs = new Set(m.target.packages.map((name) => m.strings.indexOf(name)));
  const byPkg = new Map<number, { us: number; top: Map<FnId, number>; track: number }>();
  m.tracks.forEach((t, ti) => {
    if (!isTargetTrack(m, ti)) return;
    const tree = t.callTree;
    // Package of each node's own frame; plumbing frames do not count as the package's work.
    const own = new Uint32Array(tree.length);
    for (let n = 1; n < tree.length; n++) {
      const fn = tree.fn[n] ?? 0;
      const pkg = m.functions.plumbing[fn] === 1 ? 0 : (m.functions.pkg[fn] ?? 0);
      own[n] = targetPkgs.has(pkg) ? 0 : pkg;
    }
    for (let k = 0; k < t.tasks.length; k++) {
      if (server && !isSteadyTask(t, k)) continue;
      const [a, b] = taskRange(t, k);
      for (let i = a; i < b; i++) {
        const leaf = t.samples.node[i] ?? 0;
        const dur = t.samples.dur[i] ?? 0;
        const seen: number[] = [];
        for (let n = leaf; n > 0; n = tree.parent[n] ?? 0) {
          const p = own[n] ?? 0;
          if (p === 0 || seen.includes(p)) continue;
          seen.push(p);
          const entry = byPkg.get(p) ?? { us: 0, top: new Map(), track: ti };
          entry.us += dur;
          // The deepest function of the package on this stack, not the native frame under it.
          const own1 = tree.fn[n] ?? 0;
          entry.top.set(own1, (entry.top.get(own1) ?? 0) + dur);
          byPkg.set(p, entry);
        }
      }
    }
  });
  return [...byPkg.entries()]
    .filter(([, v]) => v.us / base > th.hotDependencyShare)
    .sort((a, b) => b[1].us - a[1].us || a[0] - b[0])
    .slice(0, 2)
    .map(([pkg, v]): Finding => {
      const share = v.us / base;
      const top = [...v.top.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
      const name = text(m, pkg);
      const track = m.tracks[v.track];
      const hottest = top === undefined ? '' : `, mostly in ${where(m, top)}`;
      return {
        id: `hot-dependency:${name}`,
        kind: 'hot-dependency',
        severity: severityBy(share, 0.5, 0.35),
        title: 'Hot dependency',
        summary: `${name} accounts for ${formatPercent(share)} of the ${server ? 'time outside startup' : 'busy time'} (${formatDuration(v.us)})${hottest}.`,
        rule: `An npm package above ${formatPercent(th.hotDependencyShare)} of busy time${server ? ' outside startup' : ''}, not counting its plumbing frames or the target package itself.`,
        impact: Math.min(1, share),
        showMe: {
          view: 'callgraph',
          ...trackRef(track),
          options: { expandPackage: name },
        },
        evidence: top === undefined ? [] : [top],
        ...trackRef(track),
      };
    });
};

const gcPressure: Rule = (m, th) => {
  let best: { track: Track; share: number; pause: number; at: number; total: number } | undefined;
  for (const [ti, t] of m.tracks.entries()) {
    if (!isTargetTrack(m, ti)) continue;
    const gc = t.events.gc;
    if (gc.time.length === 0 || t.durationUs <= 0) continue;
    let total = 0;
    let pause = 0;
    let at = 0;
    for (let i = 0; i < gc.time.length; i++) {
      total += gc.duration[i] ?? 0;
      if ((gc.duration[i] ?? 0) > pause) {
        pause = gc.duration[i] ?? 0;
        at = gc.time[i] ?? 0;
      }
    }
    const share = total / t.durationUs;
    const score = Math.max(share / th.gcShare, pause / (th.gcPauseMs * 1000));
    const bestScore = best
      ? Math.max(best.share / th.gcShare, best.pause / (th.gcPauseMs * 1000))
      : -1;
    if (score > bestScore) best = { track: t, share, pause, at, total };
  }
  if (!best) return [];
  const longPause = best.pause > th.gcPauseMs * 1000;
  if (best.share <= th.gcShare && !longPause) return [];
  const summary = longPause
    ? `The longest GC pause was ${formatDuration(best.pause, false)} and GC took ${formatPercent(best.share)} of wall time.`
    : `Garbage collection took ${formatPercent(best.share)} of wall time (${formatDuration(best.total, false)}).`;
  return [
    {
      id: `gc-pressure:${best.track.id}`,
      kind: 'gc-pressure',
      severity: severityBy(Math.max(best.share, best.pause / 1e6), 0.25, 0.15),
      title: 'GC pressure',
      summary,
      rule: `GC above ${formatPercent(th.gcShare)} of wall time, or a single pause above ${th.gcPauseMs} ms.`,
      impact: Math.min(1, best.share),
      showMe: {
        view: 'timeline',
        track: best.track.id,
        range: [Math.max(0, best.at - 50_000), best.at + best.pause + 50_000],
        options: { gcMarkers: true },
      },
      evidence: [],
      track: best.track.id,
    },
  ];
};

const asyncOverhead: Rule = (m, th) => {
  let worst: { kind: number; share: number; us: number } | undefined;
  for (let kind = 0; kind < TASK_KIND_NAMES.length; kind++) {
    if (kind === TaskKind.Main) continue;
    const busy = m.taskKinds.busy[kind] ?? 0;
    if (busy / m.meta.precisionUs < th.minSamples) continue;
    const share = (m.taskKinds.plumbing[kind] ?? 0) / busy;
    const us = m.taskKinds.plumbing[kind] ?? 0;
    // The kind where the most plumbing time is lost, not the one with the highest share of a tiny total.
    if (share > th.plumbingShare && (!worst || us > worst.us)) worst = { kind, share, us };
  }
  if (!worst) return [];
  const acc = new Map<FnId, number>();
  let trackIndex = 0;
  m.tracks.forEach((t, ti) => {
    if (!isTargetTrack(m, ti)) return;
    for (let k = 0; k < t.tasks.length; k++) {
      if (t.tasks.kind[k] !== worst?.kind) continue;
      const [a, b] = taskRange(t, k);
      for (let i = a; i < b; i++) {
        const fn = t.callTree.fn[t.samples.node[i] ?? 0] ?? 0;
        if (m.functions.plumbing[fn] === 1) {
          acc.set(fn, (acc.get(fn) ?? 0) + (t.samples.dur[i] ?? 0));
          trackIndex = ti;
        }
      }
    }
  });
  const top = [...acc.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 3);
  const kindName =
    ['main', 'request', 'timer', 'immediate', 'microtask', 'I/O', 'other'][worst.kind] ?? 'other';
  const track = m.tracks[trackIndex];
  return [
    {
      id: `async-overhead:${kindName}`,
      kind: 'async-overhead',
      severity: severityBy(worst.share, 0.4, 0.25),
      title: 'Async overhead',
      summary: `Async and framework plumbing takes ${formatPercent(worst.share)} of the time in ${kindName} tasks.`,
      rule: `Plumbing frames above ${formatPercent(th.plumbingShare)} of the busy time of a task kind (startup excluded).`,
      impact: Math.min(
        1,
        worst.share * ((m.taskKinds.busy[worst.kind] ?? 0) / (totalBusy(m) || 1)),
      ),
      showMe: {
        view: 'flame',
        ...trackRef(track),
        options: { unmergePlumbing: true },
      },
      evidence: top.map(([fn]) => fn),
      ...trackRef(track),
    },
  ];
};

const heavySerialization: Rule = (m, th) => {
  const busy = totalBusy(m);
  if (busy / m.meta.precisionUs < th.minSamples) return [];
  let us = 0;
  let trackIndex = 0;
  let bestUs = 0;
  const fns = new Set<FnId>();
  m.tracks.forEach((t, ti) => {
    if (!isTargetTrack(m, ti)) return;
    const tree = t.callTree;
    const own = new Int32Array(tree.length).fill(-1);
    let trackUs = 0;
    for (let n = 1; n < tree.length; n++) {
      const p = tree.parent[n] ?? 0;
      const fn = tree.fn[n] ?? 0;
      const inherited = own[p] ?? -1;
      if (inherited >= 0) own[n] = inherited;
      else if (originOf(m, fn) === Origin.Native && JSON_NAME.test(fnName(m, fn))) {
        own[n] = fn;
        trackUs += tree.total[n] ?? 0;
        fns.add(fn);
      }
    }
    us += trackUs;
    if (trackUs > bestUs) {
      bestUs = trackUs;
      trackIndex = ti;
    }
  });
  const share = us / busy;
  if (share <= th.serializationShare) return [];
  const track = m.tracks[trackIndex];
  return [
    {
      id: 'heavy-serialization',
      kind: 'heavy-serialization',
      severity: severityBy(share, 0.25, 0.1),
      title: 'Heavy serialization',
      summary: `JSON.parse and JSON.stringify take ${formatPercent(share)} of CPU time (${formatDuration(us)}).`,
      rule: `JSON.parse or JSON.stringify above ${formatPercent(th.serializationShare)} of busy time.`,
      impact: Math.min(1, share),
      showMe: {
        view: 'functions',
        ...trackRef(track),
        options: { search: 'JSON', callersOf: true },
      },
      evidence: [...fns].sort((a, b) => a - b),
      ...trackRef(track),
    },
  ];
};

const lateModuleLoading: Rule = (m, th) => {
  interface Hit {
    track: number;
    task: number;
    taskUs: number;
    fn: FnId;
  }
  let hit: Hit | undefined;
  let total = 0;
  let denominator = 0;
  m.tracks.forEach((t, ti) => {
    if (!isTargetTrack(m, ti)) return;
    const tree = t.callTree;
    // Outermost frame of the module loader on each node's path.
    const loader = new Int32Array(tree.length).fill(-1);
    for (let n = 1; n < tree.length; n++) {
      const p = tree.parent[n] ?? 0;
      const inherited = loader[p] ?? -1;
      if (inherited >= 0) loader[n] = inherited;
      else if (fnFile(m, tree.fn[n] ?? 0).startsWith('node:internal/modules/')) loader[n] = n;
    }
    for (let k = 0; k < t.tasks.length; k++) {
      if (t.tasks.kind[k] !== TaskKind.Request) continue;
      denominator += t.tasks.busy[k] ?? 0;
      const [a, b] = taskRange(t, k);
      const perNode = new Map<number, number>();
      for (let i = a; i < b; i++) {
        const node = loader[t.samples.node[i] ?? 0] ?? -1;
        if (node >= 0) perNode.set(node, (perNode.get(node) ?? 0) + (t.samples.dur[i] ?? 0));
      }
      let taskUs = 0;
      let topFn = 0;
      let topUs = 0;
      for (const [node, us] of perNode) {
        taskUs += us;
        if (us > topUs) {
          topUs = us;
          topFn = tree.fn[node] ?? 0;
        }
      }
      total += taskUs;
      if (taskUs > 0 && (!hit || taskUs > hit.taskUs)) {
        hit = { track: ti, task: k, taskUs, fn: topFn };
      }
    }
  });
  if (!hit || total < th.lateLoadMinMs * 1000) return [];
  const track = m.tracks[hit.track];
  const share = denominator > 0 ? total / denominator : 0;
  return [
    {
      id: `late-module-loading:${track?.id ?? ''}`,
      kind: 'late-module-loading',
      severity: severityBy(share, 0.3, 0.1),
      title: 'Late module loading',
      summary: `Modules are loaded while serving requests: ${formatDuration(total)} in total (${formatPercent(share)} of request time), the largest being ${where(m, hit.fn)}.`,
      rule: `require or import() inside a request task, after startup, at least ${th.lateLoadMinMs} ms in total.`,
      impact: Math.min(1, share),
      showMe: {
        view: 'waterfall',
        ...trackRef(track),
        task: hit.task,
        fn: hit.fn,
      },
      evidence: [hit.fn],
      ...trackRef(track),
    },
  ];
};

const eventLoopLag: Rule = (m, th) => {
  const limit = th.loopLagP99Ms * 1000;
  let worst: { track: Track; p99: number; at: number } | undefined;
  for (const [ti, t] of m.tracks.entries()) {
    if (!isTargetTrack(m, ti)) continue;
    const loop = t.events.loop;
    for (let i = 0; i < loop.time.length; i++) {
      const p99 = loop.p99[i] ?? 0;
      if (p99 > limit && (!worst || p99 > worst.p99))
        worst = { track: t, p99, at: loop.time[i] ?? 0 };
    }
  }
  if (!worst) return [];
  const wall = worst.track.durationUs || 1;
  return [
    {
      id: `event-loop-lag:${worst.track.id}`,
      kind: 'event-loop-lag',
      severity: severityBy(worst.p99, 500_000, 250_000),
      title: 'Event-loop lag',
      summary: `Event loop delay peaked at ${formatDuration(worst.p99, false)} (p99 over a 100 ms interval).`,
      rule: `p99 event loop delay above ${th.loopLagP99Ms} ms in a 100 ms sampling interval.`,
      impact: Math.min(1, worst.p99 / wall),
      showMe: {
        view: 'timeline',
        track: worst.track.id,
        range: [Math.max(0, worst.at - 150_000), worst.at + 50_000],
        options: { delayLane: true },
      },
      evidence: [],
      track: worst.track.id,
    },
  ];
};

const hotPath: Rule = (m, th) => {
  // On a server hot-function already names the culprit; chains matter for commands and scripts.
  if (m.meta.runKind === 'server') return [];
  const track = m.tracks[m.primaryTrack];
  if (!track) return [];
  // Loading modules is reported as startup work; the finding is about what the target computes.
  const top = hotPaths(m, m.primaryTrack, {
    limit: 5,
    minShare: th.hotPathShare,
    origin: Origin.User,
  }).find((p) => m.functions.loader[p.fns[p.fns.length - 1] ?? 0] !== 1);
  if (!top || top.fns.length < 2 || top.totalUs / m.meta.precisionUs < th.minSamples) return [];
  const last = top.fns[top.fns.length - 1] ?? 0;
  const tail = top.fns.slice(-4);
  const chain = tail.map((fn) => fnName(m, fn)).join(' → ');
  const lead = top.fns.length > tail.length ? '… → ' : '';
  return [
    {
      id: `hot-path:${track.id}:${last}`,
      kind: 'hot-path',
      severity: severityBy(top.share, 0.5, 0.3),
      title: 'Hot path',
      summary: `${lead}${chain} (${place(m, last)}): ${formatDuration(top.totalUs)} total, ${formatPercent(top.share)} of busy time.`,
      rule: `The deepest call chain in the target's own code that still carries ${formatPercent(th.hotPathShare)} of busy time; plumbing and dependency frames fold into their caller.`,
      impact: Math.min(1, top.share),
      showMe: {
        view: 'flame',
        track: track.id,
        fn: last,
        options: { zoomPath: top.fns.join(',') },
      },
      evidence: tail,
      track: track.id,
    },
  ];
};

const RULES: Rule[] = [
  eventLoopBlocked,
  syncIo,
  hotFunction,
  hotPath,
  hotDependency,
  gcPressure,
  asyncOverhead,
  heavySerialization,
  lateModuleLoading,
  eventLoopLag,
];

export function findIssues(model: ExecutionModel, ctx: PassContext): Finding[] {
  const suppressed =
    model.meta.runKind === 'server' ? [] : (ctx.options.suppressForCli ?? DEFAULT_SUPPRESS_FOR_CLI);
  const all = RULES.flatMap((rule) => rule(model, ctx.thresholds)).filter(
    (f) => !suppressed.includes(f.kind),
  );
  return all.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.impact - a.impact ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      compareText(a.id, b.id),
  );
}
