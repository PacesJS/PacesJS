import { diffModels } from '@pacesjs/engine';
import type { ExecutionModel, ModelDiff } from '@pacesjs/engine';
import type { Selection } from '../state/types';
import type { FunctionFilter } from './adapt';
import {
  callAt,
  callGraphData,
  egoNeighbourhood,
  fileOutline,
  flameData,
  functionDetails,
  functionsTable,
  hiddenTime,
  hotPathRows,
  overviewData,
  sandwichRows,
  sourceInfo,
  taskLabelOf,
  taskOptions,
  waterfallData,
} from './adapt';
import { browserElk } from './elk-browser';
import { layoutGraph } from './layout';
import type { ElkProvider, GraphLayout } from './layout';
import { locationOf, modelCtx, scopeView, toEngineStack, trackIndexOf, trackOrder } from './scope';
import type { Scoped } from './scope';
import { EMPTY_SELECTION } from './types';
import type {
  CallGraphData,
  CallNumbers,
  CallGraphQuery,
  Details,
  FileOutline,
  FlameData,
  FlameOptions,
  FunctionsResult,
  HiddenOrigin,
  HotPathRow,
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
  FileOutline,
  FlameData,
  FlameOptions,
  FunctionsResult,
  HiddenOrigin,
  HotPathRow,
  ModelSummary,
  OverviewData,
  SandwichRow,
  Scope,
  SelectionInfo,
  SourceInfo,
  TaskOption,
  WaterfallData,
} from './types';

/** Sibling order and shortest call of the waterfall; the engine applies both. */
export interface WaterfallShape {
  sort: 'time' | 'duration' | 'share';
  minDurUs: number;
}

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
  waterfall(scope: Scope, task: number, shape: WaterfallShape): WaterfallData | null;
  flame(scope: Scope, opts: FlameOptions): FlameData;
  functions(scope: Scope, filter: string, narrow?: FunctionFilter): FunctionsResult;
  details(scope: Scope, fn: number): Details | null;
  sandwich(scope: Scope, fn: number): SandwichRow[];
  callGraph(scope: Scope, query: CallGraphQuery, expandedPackages: string[]): Promise<GraphResult>;
  source(scope: Scope, fn: number): SourceInfo | null;
  /** The numbers of the call node at `path` (UI function ids from the root), or null. */
  callAt(scope: Scope, path: number[]): CallNumbers | null;
  outline(scope: Scope, fn: number): FileOutline | null;
  /** The dominant call chains of the scope's track (engine `hotPaths`). */
  hotPaths(scope: Scope, limit: number): HotPathRow[];
  /** Self time of the origins the Show filter hides, for the "hiding ..." chip. */
  hidden(scope: Scope): HiddenOrigin[];
  describe(scope: Scope, selection: Selection): SelectionInfo;
  /** Package name of a function, '' for user code. */
  packageOf(fn: number): string;
}

const CACHE_SIZE = 6;
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
      scope.hide,
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
      toEngineStack(ctx, scope.transforms, expanded, withRange ? scope.range : null, scope.hide),
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
      const tracks = trackOrder(model).map((i) => {
        const t = model.tracks[i] as ExecutionModel['tracks'][number];
        return {
          id: t.id,
          label: t.label,
          kind: t.kind,
          role: t.role,
          primary: i === model.primaryTrack,
          entry: t.entry,
          samples: t.samples.length,
          durationUs: t.durationUs,
        };
      });
      return {
        command: model.meta.command,
        durationUs: model.meta.durationUs,
        intervalUs: model.meta.intervalUs,
        precisionUs: model.meta.precisionUs,
        endedBy: model.meta.endedBy,
        mode: model.meta.mode,
        tracks,
        primaryTrack: model.tracks[model.primaryTrack]?.id ?? '',
        target: {
          entry: model.target.entry,
          kind: model.target.kind,
          packages: model.target.packages,
        },
        findings: model.findings,
        warnings: model.meta.warnings,
        totalSamples: tracks.reduce((a, t) => a + t.samples, 0),
        projectRoot: model.meta.projectRoot,
        functionCount: F,
        packages: ctx.pkgs,
        hasBaseline: baseline !== null,
      };
    },
    overview() {
      overviewCache ??= overviewData(model);
      return overviewCache;
    },
    tasks(scope) {
      return taskOptions(model, trackIndexOf(model, scope.track));
    },
    waterfall(scope, task, shape) {
      return waterfallData(model, scoped(scope, [], false), {
        task,
        range: scope.range,
        ...shape,
      });
    },
    flame(scope, opts) {
      if (baseline && !diff) diff = diffModels(baseline, model);
      return flameData(model, scoped(scope), opts, diff);
    },
    functions(scope, filter, narrow) {
      return functionsTable(model, scoped(scope), scope.range, filter, narrow);
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
    callAt(scope, path) {
      return callAt(scoped(scope), path);
    },
    outline(scope, fn) {
      return fileOutline(model, scoped(scope), fn);
    },
    hotPaths(scope, limit) {
      return hotPathRows(model, scoped(scope), limit);
    },
    hidden(scope) {
      if (scope.hide.length === 0) return [];
      return hiddenTime(model, scoped({ ...scope, hide: [] }), scope.hide);
    },
    describe(scope, selection) {
      const s = scoped(scope);
      const named = (fn: number): Pick<SelectionInfo, 'fn' | 'name' | 'loc' | 'plumbing'> => {
        const info = s.info(fn);
        return {
          fn,
          name: info.name || '(anonymous)',
          loc: locationOf(info),
          plumbing: info.plumbing,
        };
      };
      switch (selection.kind) {
        case 'fn':
          return { ...EMPTY_SELECTION, ...named(selection.fn) };
        case 'node': {
          const fn = selection.path[selection.path.length - 1];
          if (fn === undefined) return EMPTY_SELECTION;
          return { ...EMPTY_SELECTION, ...named(fn), path: selection.path, track: selection.track };
        }
        case 'task': {
          const track = model.tracks.find((t) => t.id === selection.track);
          const i = selection.task;
          if (!track || i < 0 || i >= track.tasks.length) return EMPTY_SELECTION;
          const label = taskLabelOf(model, track, i);
          const start = track.tasks.start[i] ?? 0;
          return {
            ...EMPTY_SELECTION,
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
          return EMPTY_SELECTION;
      }
    },
    packageOf(fn) {
      return fn < F
        ? (model.strings[model.functions.pkg[fn] ?? 0] ?? '')
        : (ctx.pkgs[fn - F] ?? '');
    },
  };
}
