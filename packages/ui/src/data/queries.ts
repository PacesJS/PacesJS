import type { ExecutionModel, Finding, Track } from '@pacesjs/engine';
import type { Selection, TimeRange, Transform } from '../state/types';
import { at, fnLocation, fnName, selectTracks, str } from './access';
import { pathKeys, withDelta } from './diff';
import { buildCallGraph } from './callgraph';
import type { CallGraphData, CallGraphOptions } from './callgraph';
import { flameData } from './flame';
import type { FlameData, FlameOptions } from './flame';
import { functionDetails, functionsTable, sandwich } from './functions';
import type { Details, FunctionsResult, SandwichRow } from './functions';
import { layoutGraph } from './layout';
import type { ElkProvider, GraphLayout } from './layout';
import { browserElk } from './elk-browser';
import { buildOverview } from './overview';
import type { OverviewData } from './overview';
import { sourceInfo } from './source';
import type { SourceInfo } from './source';
import { allPackages, buildTView } from './tview';
import type { TView } from './tview';
import { buildWaterfall, taskLabel, taskOptions } from './waterfall';
import type { TaskOption, WaterfallData } from './waterfall';

/** What every aggregate query is scoped by. */
export interface Scope {
  track: string;
  transforms: Transform[];
  range: TimeRange | null;
}

export interface TrackSummary {
  id: string;
  label: string;
  kind: string;
  samples: number;
  durationUs: number;
}

export interface ModelSummary {
  command: string[];
  durationUs: number;
  intervalUs: number;
  precisionUs: number;
  endedBy: string;
  mode: string;
  tracks: TrackSummary[];
  findings: Finding[];
  warnings: string[];
  totalSamples: number;
  projectRoot: string;
  /** Function names for chips, indexed by function id (only those needed are read lazily). */
  functionCount: number;
  hasBaseline: boolean;
}

export interface TaskInfo {
  index: number;
  label: string;
  startUs: number;
  durationUs: number;
  busyUs: number;
  kind: number;
}

export interface SelectionInfo {
  fn: number | null;
  /** Original call-tree node for node and span selections. */
  node: number | null;
  name: string;
  track: string | null;
  /** Task selection details when the selection is a task. */
  task: TaskInfo | null;
  loc: string;
}

export interface GraphResult {
  graph: CallGraphData;
  layout: GraphLayout;
}

export interface Queries {
  summary(): ModelSummary;
  overview(): OverviewData;
  tasks(scope: Scope): TaskOption[];
  waterfall(scope: Scope, task: number): WaterfallData | null;
  flame(scope: Scope, opts: FlameOptions): FlameData;
  functions(scope: Scope, filter: string): FunctionsResult;
  details(scope: Scope, fn: number): Details | null;
  sandwich(scope: Scope, fn: number): SandwichRow[];
  callGraph(scope: Scope, opts: CallGraphOptions, expanded: string[]): Promise<GraphResult>;
  source(scope: Scope, fn: number): SourceInfo | null;
  describe(selection: Selection): SelectionInfo;
  /** Function ids matching a transformed-tree node, for flame clicks. */
  fnOfNode(scope: Scope, node: number): number;
  /** Package name of a function, '' for user code. */
  packageOf(fn: number): string;
  fnName(fn: number): string;
}

const CACHE_SIZE = 6;

export function createQueries(
  model: ExecutionModel,
  baseline: ExecutionModel | null = null,
  elk: ElkProvider = browserElk,
): Queries {
  const hasBaseline = baseline !== null;
  const cache = new Map<string, TView>();

  function tracksOf(scope: Scope): Track[] {
    return selectTracks(model, scope.track);
  }

  function tview(scope: Scope, expanded: readonly string[] = []): TView {
    const key = JSON.stringify([scope.track, scope.transforms, scope.range, expanded]);
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const built = buildTView({
      model,
      tracks: tracksOf(scope),
      transforms: scope.transforms,
      range: scope.range,
      expandedPkgs: expanded,
    });
    cache.set(key, built);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    return built;
  }

  let overviewCache: OverviewData | null = null;

  return {
    summary() {
      const tracks = model.tracks.map((t) => ({
        id: t.id,
        label: t.label,
        kind: t.kind,
        samples: t.samples.length,
        durationUs: t.durationUs,
      }));
      return {
        command: model.meta.command,
        durationUs: model.meta.durationUs,
        intervalUs: model.meta.intervalUs,
        precisionUs: model.meta.precisionUs,
        endedBy: model.meta.endedBy,
        mode: model.meta.mode,
        tracks,
        findings: model.findings,
        warnings: model.meta.warnings,
        totalSamples: tracks.reduce((a, t) => a + t.samples, 0),
        projectRoot: model.meta.projectRoot,
        functionCount: model.functions.length,
        hasBaseline,
      };
    },
    overview() {
      overviewCache ??= buildOverview(model);
      return overviewCache;
    },
    tasks(scope) {
      const t = tracksOf(scope)[0];
      return t ? taskOptions(model, t) : [];
    },
    waterfall(scope, task) {
      const t = tracksOf(scope)[0];
      return t ? buildWaterfall(model, t, { transforms: scope.transforms, task }) : null;
    },
    flame(scope, opts) {
      const now = tview(scope);
      const data = flameData(model, now, opts);
      if (!baseline) return data;
      // Function ids belong to one model, so only id-free transforms carry over to the baseline.
      const generic = scope.transforms.filter((t) =>
        ['collapse-deps', 'merge-plumbing', 'drop-idle', 'invert', 'collapse-pkg'].includes(t.k),
      );
      const base = buildTView({
        model: baseline,
        tracks: selectTracks(baseline, scope.track),
        transforms: generic,
        range: null,
      });
      return withDelta(
        data,
        pathKeys(model, now),
        now.keptUs,
        pathKeys(baseline, base),
        base.total,
        base.keptUs,
      );
    },
    functions(scope, filter) {
      return functionsTable(model, tview(scope), tracksOf(scope), scope.range, filter);
    },
    details(scope, fn) {
      return functionDetails(model, tview(scope), tracksOf(scope), scope.range, fn);
    },
    sandwich(scope, fn) {
      return sandwich(model, tview(scope), fn);
    },
    async callGraph(scope, opts, expanded) {
      const t = tview(scope, expanded);
      const graph = buildCallGraph(model, t, tracksOf(scope), scope.range, opts);
      return { graph, layout: await layoutGraph(graph, elk()) };
    },
    source(scope, fn) {
      return sourceInfo(model, tracksOf(scope), fn);
    },
    describe(selection) {
      const none: SelectionInfo = {
        fn: null,
        node: null,
        name: '',
        track: null,
        task: null,
        loc: '',
      };
      switch (selection.kind) {
        case 'fn':
          return {
            ...none,
            fn: selection.fn,
            name: viewFnNameSafe(selection.fn),
            loc: fnLocation(model, selection.fn),
          };
        case 'node': {
          const track = model.tracks.find((t) => t.id === selection.track);
          const fn = track ? at(track.callTree.fn, selection.node) : null;
          return fn === null
            ? none
            : {
                ...none,
                fn,
                node: selection.node,
                track: selection.track,
                name: viewFnNameSafe(fn),
                loc: fnLocation(model, fn),
              };
        }
        case 'span': {
          const track = model.tracks.find((t) => t.id === selection.track);
          const fn = track ? at(track.spans.fn, selection.span) : null;
          const node = track ? at(track.spans.node, selection.span) : null;
          return fn === null
            ? none
            : {
                ...none,
                fn,
                node,
                track: selection.track,
                name: viewFnNameSafe(fn),
                loc: fnLocation(model, fn),
              };
        }
        case 'task': {
          const track = model.tracks.find((t) => t.id === selection.track);
          if (!track || selection.task >= track.tasks.length) return none;
          const i = selection.task;
          return {
            ...none,
            track: selection.track,
            name: taskLabel(model, track, i),
            task: {
              index: i,
              label: taskLabel(model, track, i),
              startUs: at(track.tasks.start, i),
              durationUs: at(track.tasks.end, i) - at(track.tasks.start, i),
              busyUs: at(track.tasks.busy, i),
              kind: at(track.tasks.kind, i),
            },
          };
        }
        default:
          return none;
      }
    },
    fnOfNode(scope, node) {
      const t = tview(scope);
      return at(t.fn, node);
    },
    packageOf(fn) {
      return str(model, at(model.functions.pkg, fn));
    },
    fnName(fn) {
      return viewFnNameSafe(fn);
    },
  };

  function viewFnNameSafe(fn: number): string {
    return fn < model.functions.length
      ? fnName(model, fn)
      : (allPackages(model)[fn - model.functions.length] ?? '(package)');
  }
}
