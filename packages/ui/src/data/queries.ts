import { diffModels } from '@pacesjs/engine';
import type { ExecutionModel, ModelDiff } from '@pacesjs/engine';
import type { Selection } from '../state/types';
import {
  callGraphData,
  egoNeighbourhood,
  flameData,
  functionDetails,
  functionsTable,
  overviewData,
  sandwichRows,
  sourceInfo,
  taskOptions,
  waterfallData,
} from './adapt';
import { browserElk } from './elk-browser';
import { layoutGraph } from './layout';
import type { ElkProvider, GraphLayout } from './layout';
import { locationOf, modelCtx, scopeView, toEngineStack, trackIndexOf } from './scope';
import type { Scoped } from './scope';
import type {
  CallGraphData,
  CallGraphQuery,
  Details,
  FlameData,
  FlameOptions,
  FunctionsResult,
  ModelSummary,
  OverviewData,
  SandwichRow,
  Scope,
  SelectionInfo,
  SourceInfo,
  TaskOption,
  WaterfallData,
} from './types';

export type {
  CallGraphData,
  CallGraphQuery,
  Details,
  FlameData,
  FlameOptions,
  FunctionsResult,
  ModelSummary,
  OverviewData,
  SandwichRow,
  Scope,
  SelectionInfo,
  SourceInfo,
  TaskOption,
  WaterfallData,
} from './types';

export interface GraphResult {
  graph: CallGraphData;
  layout: GraphLayout;
  /** Functions inside the ego neighbourhood of the selected function, or null without ego. */
  near: number[] | null;
}

/** Everything the views ask for. Names and shapes are the views'; the numbers are the engine's. */
export interface Queries {
  summary(): ModelSummary;
  overview(): OverviewData;
  tasks(scope: Scope): TaskOption[];
  waterfall(scope: Scope, task: number): WaterfallData | null;
  flame(scope: Scope, opts: FlameOptions): FlameData;
  functions(scope: Scope, filter: string): FunctionsResult;
  details(scope: Scope, fn: number): Details | null;
  sandwich(scope: Scope, fn: number): SandwichRow[];
  callGraph(scope: Scope, query: CallGraphQuery, expandedPackages: string[]): Promise<GraphResult>;
  source(scope: Scope, fn: number): SourceInfo | null;
  describe(scope: Scope, selection: Selection): SelectionInfo;
  /** Package name of a function, '' for user code. */
  packageOf(fn: number): string;
}

const CACHE_SIZE = 6;
const NO_SELECTION: SelectionInfo = {
  fn: null,
  path: null,
  name: '',
  track: null,
  task: null,
  loc: '',
};

export function createQueries(
  model: ExecutionModel,
  baseline: ExecutionModel | null = null,
  elk: ElkProvider = browserElk,
): Queries {
  const ctx = modelCtx(model);
  const F = model.functions.length;
  const cache = new Map<string, Scoped>();
  const layouts = new Map<string, GraphLayout>();
  let diff: ModelDiff | null = null;
  let overviewCache: OverviewData | null = null;

  /** The scoped view for the aggregate views: stack plus time range. */
  function scoped(scope: Scope, expanded: readonly string[] = [], withRange = true): Scoped {
    const key = JSON.stringify([
      scope.track,
      scope.transforms,
      withRange ? scope.range : null,
      expanded,
    ]);
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const built = scopeView(
      ctx,
      trackIndexOf(model, scope.track),
      toEngineStack(ctx, scope.transforms, expanded, withRange ? scope.range : null),
    );
    cache.set(key, built);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    return built;
  }

  const memberCount = (pkg: string): number => {
    let n = 0;
    for (let f = 0; f < F; f++) if ((model.strings[model.functions.pkg[f] ?? 0] ?? '') === pkg) n++;
    return n;
  };

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
        functionCount: F,
        hasBaseline: baseline !== null,
      };
    },
    overview() {
      overviewCache ??= overviewData(model);
      return overviewCache;
    },
    tasks(scope) {
      const track = model.tracks[trackIndexOf(model, scope.track)];
      return track ? taskOptions(model, track) : [];
    },
    waterfall(scope, task) {
      return waterfallData(model, scoped(scope, [], false), { task, range: scope.range });
    },
    flame(scope, opts) {
      if (baseline && !diff) diff = diffModels(baseline, model);
      return flameData(model, scoped(scope), opts, diff);
    },
    functions(scope, filter) {
      return functionsTable(model, scoped(scope), scope.range, filter);
    },
    details(scope, fn) {
      return functionDetails(model, scoped(scope), scope.range, fn);
    },
    sandwich(scope, fn) {
      return sandwichRows(model, scoped(scope), fn);
    },
    async callGraph(scope, query, expandedPackages) {
      const s = scoped(scope, expandedPackages);
      const graph = callGraphData(model, s, query, memberCount);
      const key = JSON.stringify([
        graph.nodes.map((n) => [n.fn, n.selfUs]),
        graph.edges.map((e) => [e.from, e.to]),
      ]);
      let layout = layouts.get(key);
      if (!layout) {
        layout = await layoutGraph(graph, elk());
        layouts.set(key, layout);
        if (layouts.size > CACHE_SIZE) layouts.delete(layouts.keys().next().value as string);
      }
      const near =
        query.ego !== null && graph.nodes.some((n) => n.fn === query.ego)
          ? egoNeighbourhood(model, s, query.ego)
          : null;
      return { graph, layout, near };
    },
    source(scope, fn) {
      return sourceInfo(model, scoped(scope), fn);
    },
    describe(scope, selection) {
      const s = scoped(scope);
      const named = (fn: number): Pick<SelectionInfo, 'fn' | 'name' | 'loc'> => {
        const info = s.info(fn);
        return { fn, name: info.name || '(anonymous)', loc: locationOf(info) };
      };
      switch (selection.kind) {
        case 'fn':
          return { ...NO_SELECTION, ...named(selection.fn) };
        case 'node': {
          const fn = selection.path[selection.path.length - 1];
          if (fn === undefined) return NO_SELECTION;
          return { ...NO_SELECTION, ...named(fn), path: selection.path, track: selection.track };
        }
        case 'task': {
          const track = model.tracks.find((t) => t.id === selection.track);
          const i = selection.task;
          if (!track || i < 0 || i >= track.tasks.length) return NO_SELECTION;
          const label = model.strings[track.tasks.label[i] ?? 0] || 'task';
          const start = track.tasks.start[i] ?? 0;
          return {
            ...NO_SELECTION,
            track: selection.track,
            name: label,
            task: {
              index: i,
              label,
              startUs: start,
              durationUs: (track.tasks.end[i] ?? 0) - start,
              busyUs: track.tasks.busy[i] ?? 0,
              kind: track.tasks.kind[i] ?? 0,
            },
          };
        }
        default:
          return NO_SELECTION;
      }
    },
    packageOf(fn) {
      return fn < F
        ? (model.strings[model.functions.pkg[fn] ?? 0] ?? '')
        : (ctx.pkgs[fn - F] ?? '');
    },
  };
}
