// Pass 10: a compact, JSON-serializable digest for coding agents: top findings, hot paths with
// source locations and task statistics. No typed arrays, no ids that need the model to decode.

import { Origin, ORIGIN_NAMES, TASK_KIND_NAMES } from './model.js';
import type { ExecutionModel, FnId, ModelWarning, RunKind, Severity, TrackRole } from './model.js';
import { phasesOf } from './agent-phases.js';
import { hotPaths } from './query/paths.js';

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
  /** Self time of the last frame. */
  selfMs: number;
  /** Total time of the last frame. */
  totalMs: number;
  /** Share of the track's busy time. */
  share: number;
}

export interface AgentPackage {
  name: string;
  /** The profiled program's own package. */
  isTarget: boolean;
  /** Whole run, all tracks. */
  selfMs: number;
  totalMs: number;
  share: number;
  /** Hottest functions of this package on the target tracks, by self time. */
  topFunctions: AgentFunction[];
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
  /** 2: target, runKind, primaryTrack, topSelf, phases and caveats were added; hotPaths and packages changed shape. */
  schemaVersion: 2;
  engineVersion: string;
  command: string[];
  mode: string;
  sampled: true;
  durationMs: number;
  /** Plus or minus this many milliseconds on every sampled duration. */
  precisionMs: number;
  /** What was profiled: the target package(s) (empty for the project itself), entry script and kind. */
  target: { packages: string[]; entry: string; kind: RunKind };
  runKind: RunKind;
  /** The target process: the busiest non-supporting one. */
  primaryTrack: { index: number; id: string; label: string };
  tracks: Array<{
    id: string;
    label: string;
    kind: string;
    role: TrackRole;
    busyMs: number;
    durationMs: number;
  }>;
  findings: AgentFinding[];
  /** The 10 first entries of `topSelf`. */
  topFunctions: AgentFunction[];
  /** Top 25 functions by self time across the target's tracks, any origin. */
  topSelf: AgentFunction[];
  /** Up to 8 dominant call chains of the target's tracks, ranked by total time. */
  hotPaths: AgentHotPath[];
  /** Top 10 packages by total time, each with its 3 hottest functions. */
  packages: AgentPackage[];
  /** Time-ordered phases of the primary track. */
  phases: AgentPhase[];
  /** Aggregated warnings: things that limit how far the numbers can be trusted. */
  caveats: ModelWarning[];
  taskStats: {
    count: number;
    longTasks: number;
    byKind: Record<string, AgentTaskKindStats>;
    longest: Array<{ track: string; label: string; startMs: number; durationMs: number }>;
  };
  /** `caveats[i].summary`, for readers that want plain strings. */
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
  const busy = model.tracks.reduce((n, t) => n + (t.role === 'target' ? t.busyUs : 0), 0) || 1;

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

  // Function totals over the target's tracks (workers included, launcher processes left out).
  const isTarget = (ti: number): boolean => model.tracks[ti]?.role === 'target';
  const self = new Map<FnId, number>();
  const total = new Map<FnId, number>();
  model.tracks.forEach((t, ti) => {
    if (!isTarget(ti)) return;
    t.fnIds.forEach((fn, i) => {
      self.set(fn, (self.get(fn) ?? 0) + (t.agg.fnSelf[i] ?? 0));
      total.set(fn, (total.get(fn) ?? 0) + (t.agg.fnTotal[i] ?? 0));
    });
  });
  const real = (fn: FnId): boolean => {
    const o = model.functions.origin[fn] ?? 0;
    return (
      o !== Origin.Idle &&
      o !== Origin.Gc &&
      model.strings[model.functions.name[fn] ?? 0] !== '(root)'
    );
  };
  const describe = (fn: FnId, selfUs: number): AgentFunction => ({
    ...where(fn),
    origin: ORIGIN_NAMES[model.functions.origin[fn] ?? 0] ?? 'user',
    pkg: model.strings[model.functions.pkg[fn] ?? 0] ?? '',
    selfMs: ms(selfUs),
    totalMs: ms(total.get(fn) ?? 0),
    share: share(selfUs / busy),
  });
  const bySelf = [...self.entries()]
    .filter(([fn, v]) => real(fn) && v > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const topSelf: AgentFunction[] = bySelf.slice(0, 25).map(([fn, v]) => describe(fn, v));
  const topFunctions = topSelf.slice(0, 10);

  // Hot paths: the dominant chains of each target track, ranked by total time.
  const chains: Array<{ track: number; us: number; path: AgentHotPath }> = [];
  model.tracks.forEach((t, ti) => {
    if (!isTarget(ti)) return;
    for (const p of hotPaths(model, ti, { limit: 8 })) {
      chains.push({
        track: ti,
        us: p.totalUs,
        path: {
          track: t.id,
          path: p.fns.map(where),
          selfMs: ms(p.selfUs),
          totalMs: ms(p.totalUs),
          share: share(p.share),
        },
      });
    }
  });
  chains.sort((a, b) => b.us - a.us || a.track - b.track);
  const hotPathList = chains.slice(0, 8).map((c) => c.path);

  const targetPackages = new Set(model.target.packages);
  const pkgFns = new Map<string, Array<[FnId, number]>>();
  for (const [fn, v] of bySelf) {
    const name = model.strings[model.functions.pkg[fn] ?? 0] ?? '';
    if (!name) continue;
    const list = pkgFns.get(name);
    if (list) list.push([fn, v]);
    else pkgFns.set(name, [[fn, v]]);
  }
  const packages: AgentPackage[] = Array.from(
    { length: Math.min(10, model.packages.length) },
    (_, i) => {
      const name = model.strings[model.packages.name[i] ?? 0] ?? '';
      return {
        name,
        isTarget: targetPackages.has(name),
        selfMs: ms(model.packages.self[i] ?? 0),
        totalMs: ms(model.packages.total[i] ?? 0),
        share: share((model.packages.total[i] ?? 0) / busy),
        topFunctions: (pkgFns.get(name) ?? []).slice(0, 3).map(([fn, v]) => describe(fn, v)),
      };
    },
  );

  const phases = phasesOf(model, busy);

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
    schemaVersion: 2,
    engineVersion: model.meta.engineVersion,
    command: model.meta.command,
    mode: model.meta.mode,
    sampled: true,
    durationMs: ms(model.meta.durationUs),
    precisionMs: ms(model.meta.precisionUs),
    target: { ...model.target, packages: [...model.target.packages] },
    runKind: model.meta.runKind,
    primaryTrack: {
      index: model.primaryTrack,
      id: model.tracks[model.primaryTrack]?.id ?? '',
      label: model.tracks[model.primaryTrack]?.label ?? '',
    },
    tracks: model.tracks.map((t) => ({
      id: t.id,
      label: t.label,
      kind: t.kind,
      role: t.role,
      busyMs: ms(t.busyUs),
      durationMs: ms(t.durationUs),
    })),
    findings,
    topFunctions,
    topSelf,
    hotPaths: hotPathList,
    packages,
    phases,
    caveats: model.meta.warnings,
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
    warnings: model.meta.warnings.map((w) => w.summary),
  };
}

function taskKindName(kind: number): string {
  return TASK_KIND_NAMES[kind] ?? 'other';
}
