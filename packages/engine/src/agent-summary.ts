// Pass 10: a compact, JSON-serializable digest for coding agents: top findings, hot paths with
// source locations and task statistics. No typed arrays, no ids that need the model to decode.

import { Origin, ORIGIN_NAMES, TASK_KIND_NAMES } from './model.js';
import type { ExecutionModel, FnId, Severity } from './model.js';

export interface SourceLocation {
  name: string;
  /** Project-relative original path, or a node: URL for runtime internals. */
  file: string;
  line: number;
}

export interface AgentFinding {
  kind: string;
  severity: Severity;
  title: string;
  summary: string;
  rule: string;
  /** 0..1 share used for ranking. */
  impact: number;
  evidence: SourceLocation[];
  /** Where the UI would open: view plus the source location when there is one. */
  showMe: { view: string; track: string | null; task: number | null } & Partial<SourceLocation>;
}

export interface AgentHotPath {
  track: string;
  /** Call path from outermost to innermost frame, plumbing frames omitted. */
  path: SourceLocation[];
  selfMs: number;
  share: number;
}

export interface AgentFunction extends SourceLocation {
  origin: string;
  pkg: string;
  selfMs: number;
  totalMs: number;
  share: number;
}

export interface AgentTaskKindStats {
  count: number;
  busyMs: number;
  p50Ms: number;
  maxMs: number;
}

export interface AgentSummary {
  schemaVersion: 1;
  engineVersion: string;
  command: string[];
  mode: string;
  sampled: true;
  durationMs: number;
  /** Plus or minus this many milliseconds on every sampled duration. */
  precisionMs: number;
  tracks: Array<{ id: string; label: string; kind: string; busyMs: number; durationMs: number }>;
  findings: AgentFinding[];
  topFunctions: AgentFunction[];
  hotPaths: AgentHotPath[];
  packages: Array<{ name: string; totalMs: number; share: number }>;
  taskStats: {
    count: number;
    longTasks: number;
    byKind: Record<string, AgentTaskKindStats>;
    longest: Array<{ track: string; label: string; startMs: number; durationMs: number }>;
  };
  warnings: string[];
}

const ms = (us: number): number => Math.round(us / 100) / 10;
const share = (x: number): number => Math.round(x * 1000) / 1000;

export function buildAgentSummary(model: ExecutionModel): AgentSummary {
  const where = (fn: FnId): SourceLocation => ({
    name: model.strings[model.functions.name[fn] ?? 0] || '(anonymous)',
    file: model.strings[model.functions.file[fn] ?? 0] ?? '',
    line: model.functions.line[fn] ?? 0,
  });
  const busy = model.tracks.reduce((n, t) => n + t.busyUs, 0) || 1;

  const findings: AgentFinding[] = model.findings.slice(0, 10).map((f) => {
    const target = f.showMe.fn;
    return {
      kind: f.kind,
      severity: f.severity,
      title: f.title,
      summary: f.summary,
      rule: f.rule,
      impact: share(f.impact),
      evidence: f.evidence.map(where),
      showMe: {
        view: f.showMe.view,
        track: f.showMe.track ?? null,
        task: f.showMe.task ?? null,
        ...(target === undefined ? {} : where(target)),
        ...(f.showMe.line === undefined || target === undefined ? {} : { line: f.showMe.line }),
      },
    };
  });

  // Whole-run function totals across tracks.
  const self = new Map<FnId, number>();
  const total = new Map<FnId, number>();
  for (const t of model.tracks) {
    t.fnIds.forEach((fn, i) => {
      self.set(fn, (self.get(fn) ?? 0) + (t.agg.fnSelf[i] ?? 0));
      total.set(fn, (total.get(fn) ?? 0) + (t.agg.fnTotal[i] ?? 0));
    });
  }
  const real = (fn: FnId): boolean => {
    const o = model.functions.origin[fn] ?? 0;
    return (
      o !== Origin.Idle &&
      o !== Origin.Gc &&
      model.strings[model.functions.name[fn] ?? 0] !== '(root)'
    );
  };
  const topFunctions: AgentFunction[] = [...self.entries()]
    .filter(([fn, v]) => real(fn) && v > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 10)
    .map(([fn, v]) => ({
      ...where(fn),
      origin: ORIGIN_NAMES[model.functions.origin[fn] ?? 0] ?? 'user',
      pkg: model.strings[model.functions.pkg[fn] ?? 0] ?? '',
      selfMs: ms(v),
      totalMs: ms(total.get(fn) ?? 0),
      share: share(v / busy),
    }));

  // Hot paths: the heaviest self-time nodes, as their full call path without plumbing.
  const candidates: Array<{ track: number; node: number; self: number }> = [];
  model.tracks.forEach((t, ti) => {
    for (let n = 1; n < t.callTree.length; n++) {
      const fn = t.callTree.fn[n] ?? 0;
      const s = t.callTree.self[n] ?? 0;
      if (s > 0 && real(fn)) candidates.push({ track: ti, node: n, self: s });
    }
  });
  candidates.sort((a, b) => b.self - a.self || a.track - b.track || a.node - b.node);
  const hotPaths: AgentHotPath[] = candidates.slice(0, 5).map((c) => {
    const t = model.tracks[c.track];
    const path: SourceLocation[] = [];
    for (let n = c.node; t && n > 0; n = t.callTree.parent[n] ?? 0) {
      const fn = t.callTree.fn[n] ?? 0;
      if (model.functions.plumbing[fn] !== 1 || n === c.node) path.push(where(fn));
    }
    return {
      track: t?.id ?? '',
      path: path.reverse(),
      selfMs: ms(c.self),
      share: share(c.self / busy),
    };
  });

  const packages = Array.from({ length: Math.min(5, model.packages.length) }, (_, i) => ({
    name: model.strings[model.packages.name[i] ?? 0] ?? '',
    totalMs: ms(model.packages.total[i] ?? 0),
    share: share((model.packages.total[i] ?? 0) / busy),
  }));

  const durations: Record<string, number[]> = {};
  const longest: Array<{
    track: string;
    label: string;
    startMs: number;
    durationMs: number;
    us: number;
  }> = [];
  let taskCount = 0;
  let longTasks = 0;
  for (const t of model.tracks) {
    for (let k = 0; k < t.tasks.length; k++) {
      const dur = (t.tasks.end[k] ?? 0) - (t.tasks.start[k] ?? 0);
      const kind = taskKindName(t.tasks.kind[k] ?? 6);
      (durations[kind] ??= []).push(dur);
      taskCount++;
      if (dur > 50_000) longTasks++;
      longest.push({
        track: t.id,
        label: model.strings[t.tasks.label[k] ?? 0] ?? '',
        startMs: ms(t.tasks.start[k] ?? 0),
        durationMs: ms(dur),
        us: dur,
      });
    }
  }
  const byKind: Record<string, AgentTaskKindStats> = {};
  for (const kind of Object.keys(durations).sort()) {
    const list = [...(durations[kind] ?? [])].sort((a, b) => a - b);
    byKind[kind] = {
      count: list.length,
      busyMs: ms(list.reduce((a, b) => a + b, 0)),
      p50Ms: ms(list[Math.floor(list.length / 2)] ?? 0),
      maxMs: ms(list[list.length - 1] ?? 0),
    };
  }
  longest.sort((a, b) => b.us - a.us || (a.track < b.track ? -1 : 1) || a.startMs - b.startMs);

  return {
    schemaVersion: 1,
    engineVersion: model.meta.engineVersion,
    command: model.meta.command,
    mode: model.meta.mode,
    sampled: true,
    durationMs: ms(model.meta.durationUs),
    precisionMs: ms(model.meta.precisionUs),
    tracks: model.tracks.map((t) => ({
      id: t.id,
      label: t.label,
      kind: t.kind,
      busyMs: ms(t.busyUs),
      durationMs: ms(t.durationUs),
    })),
    findings,
    topFunctions,
    hotPaths,
    packages,
    taskStats: {
      count: taskCount,
      longTasks,
      byKind,
      longest: longest.slice(0, 5).map((l) => ({
        track: l.track,
        label: l.label,
        startMs: l.startMs,
        durationMs: l.durationMs,
      })),
    },
    warnings: model.meta.warnings,
  };
}

function taskKindName(kind: number): string {
  return TASK_KIND_NAMES[kind] ?? 'other';
}
