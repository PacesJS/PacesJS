# @pacesjs/engine

The paces analysis engine: ten passes that turn a raw capture into one columnar execution model, plus
the query and transform layer that every view reads. Pure TypeScript, no Node and no DOM, so the same
code runs in the CLI (analysis) and in the UI's Web Worker (queries).

```ts
import { analyze, applyTransforms, DEFAULT_TRANSFORMS, flameLayout } from '@pacesjs/engine';

const model = analyze(capture); // RawCapture -> ExecutionModel (CLI process)
const view = applyTransforms(model, 0, DEFAULT_TRANSFORMS); // per track (UI worker)
const flame = flameLayout(model, view, { sort: 'left-heavy' });
```

Data flows one way: `RawCapture` (collector) -> `ExecutionModel` (CLI) -> queries (UI worker). Nothing in
the model is an object reference: row ids are indexes, tables are typed arrays, strings are interned
once in `model.strings` (index 0 is the empty string).

## Public API

All names are exported from `src/index.ts`.

| Export                                              | Purpose                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `analyze(capture, options?)`                        | Runs the ten passes. Pure and deterministic. Missing data degrades with a warning in `model.meta.warnings`, never an error.                                                                                                                                                        |
| `serializeModel(model)` / `deserializeModel(bytes)` | Compact binary: JSON header, typed array buffers (8-byte aligned, shared arrays stored once), engine-version stamp. `deserializeModel` throws `ModelVersionError` when the engine version differs (re-analyze the capture); `readModelEngineVersion(bytes)` reads the stamp alone. |
| `buildAgentSummary(model)`                          | JSON-serializable digest: top findings with source locations, hot paths, top functions, packages, task statistics.                                                                                                                                                                 |
| `diffModels(base, head)`                            | Differential data (v1.x). Functions match by `functionKey`: project-relative original path, function name and original line. Never minified positions.                                                                                                                             |
| `DEFAULT_THRESHOLDS`                                | The finding thresholds from the design doc (see below).                                                                                                                                                                                                                            |
| `applyTransforms`, query functions                  | The query layer, below.                                                                                                                                                                                                                                                            |

```ts
interface AnalyzeOptions {
  thresholds?: Partial<Thresholds>;
  /** Regex source -> origin ('user' | 'dependency' | 'framework' | 'node' | 'native'),
   *  tested against the normalized original file path. Overrides the built-in rules. */
  classification?: Record<string, OriginName>;
  /** Regex sources tested against `<file>#<function name>`; a match marks plumbing. */
  plumbingPatterns?: string[];
}
```

### Honest data

- Every sampled duration is an estimate. `meta.precisionUs` is the larger of the configured interval and
  the measured median gap between samples (about 1.6 ms on Windows even at a 1 ms setting). Show it as
  `±N ms`, prefix durations with `~`, and hatch anything shorter than two intervals
  (`WaterfallRow.hatched` already does).
- Profile timestamps are monotonic; events and `meta.startedAt` are epoch time. The engine aligns them
  once per capture (`passes/clock.ts`): the profile must fit inside the run, and within that range GC
  samples are matched to GC events and request windows to busy time. All model times are microseconds
  since `meta.startedAt`.
- Sampled profiles carry no call-site line. `CallSite.line` is always 0.

## Execution model

`ExecutionModel` is defined in `src/model.ts` (the contract). Highlights:

- `functions`: one row per distinct function after source mapping. Columns `name`, `file` (project
  relative, '/' separated), `line` (1-based, original), `col`, `origin`, `pkg`, `plumbing`, `mapped`,
  `mapMissing`.
- `tracks[]`: `callTree` (preorder; subtree of `i` is `[i, subtreeEnd[i])`; self and total in
  microseconds), `samples` (`time`, `node`, `dur`), `spans`, `tasks`, `asyncEdges`, `events`, `lines`
  (CSR per function id: original line -> self microseconds), `agg` (per function self, total with
  recursion once, estimated calls, call edges), `fnIds`, `busyUs`, `durationUs`.
- `packages`: whole-run self and total per npm package. `taskKinds`: count, busy and plumbing time per
  task kind (`TaskKind`).
- `findings`: ranked by severity, then impact, then rule order, then id.

### Additions to the original model contract

`Samples.dur`, `Track.agg` (`TrackAggregates`, `EdgeTable`), `ExecutionModel.packages` (`PackageTable`),
`ExecutionModel.taskKinds` (`TaskKindStats`). Everything else in `model.ts` is unchanged.

### Findings

Pure rule functions; each finding has one sentence with a number, evidence function ids, a `showMe`
target and a `rule` string that echoes the thresholds. Startup (`TaskKind.Main`) tasks are excluded from
rules about blocking, dependencies, plumbing and module loading, because every program loads code.

| Kind                  | Default trigger                                                                                                                                | `showMe`                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `event-loop-blocked`  | A non-startup task longer than 50 ms                                                                                                           | waterfall, longest task, `criticalPath` |
| `sync-io`             | `fs`, `child_process`, `zlib`, `crypto` `*Sync` inside a request or timer task, at least 5 ms in total (module loading is reported separately) | waterfall, user caller, its line        |
| `hot-function`        | A user function above 10% of busy time (native frames it calls count as its own; one finding per function across tracks)                       | functions, hottest line                 |
| `hot-dependency`      | An npm package above 20% of busy time outside startup, not counting its plumbing                                                               | call graph, `expandPackage`             |
| `gc-pressure`         | GC above 10% of wall time, or a pause above 50 ms                                                                                              | timeline range, `gcMarkers`             |
| `async-overhead`      | Plumbing self time above 15% of a task kind's busy time (the kind losing the most time is reported)                                            | flame, `unmergePlumbing`                |
| `heavy-serialization` | `JSON.parse` or `JSON.stringify` above 5% of busy time                                                                                         | functions, `search: 'JSON'`             |
| `late-module-loading` | The module loader inside request tasks, at least 5 ms in total                                                                                 | waterfall at the load                   |
| `event-loop-lag`      | p99 loop delay above 100 ms                                                                                                                    | timeline, `delayLane`                   |

## Query layer

Everything below is pure, runs in the UI worker and reads a `TransformedView`. Types live in
`src/query/types.ts`.

### Transforms

```ts
type Transform =
  | { kind: 'merge-function'; fn }          | { kind: 'merge-node'; path }
  | { kind: 'focus-subtree'; path }         | { kind: 'focus-function'; fn }
  | { kind: 'focus-function-self'; fn }     | { kind: 'collapse-package'; pkg: string }
  | { kind: 'collapse-recursion'; fn }      | { kind: 'drop-samples'; fn }
  | { kind: 'time-range'; start; end }      | { kind: 'invert' }
  | { kind: 'collapse-dependencies' }       | { kind: 'merge-plumbing' } | { kind: 'drop-idle' };

const DEFAULT_TRANSFORMS: readonly Transform[]; // collapse-dependencies, merge-plumbing, drop-idle

applyTransforms(model, trackIndex, stack): TransformedView
```

- `path` is the chain of function ids from the root's child down to a call node, so transforms survive
  tree rewrites and serialize into the URL hash.
- Transforms apply in stack order. Each step is O(nodes + samples) (60 000 samples: about 5 ms
  realistic, 35 ms worst case for the default stack).
- A `TransformedView` has `tree` (preorder, node 0 is always `(root)`), `samples` (surviving samples,
  `node` indexes the view tree), `inverted`, `totalUs` and `syntheticPackages`. Collapsed packages
  become synthetic function ids `model.functions.length + i`; use `describeFunction(model, fn,
view.syntheticPackages)` to get a `FunctionInfo` for any id.
- Helpers: `childrenOf(tree, node)`, `nodePath(tree, node)`, `findNode(tree, path)`.
- An empty stack returns the track's own tree and samples without copying.

### Views

| Function                                                      | Returns                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------- |
| `waterfallForTask(model, view, task, options?)`               | `Waterfall` for a task of `view.trackIndex`                     |
| `waterfallForRange(model, view, start, end, options?)`        | `Waterfall` for a time range                                    |
| `flameLayout(model, view, options?)`                          | `FlameLayout` (typed arrays, fractions of the root)             |
| `flameLayoutOfTree(model, tree, syntheticPackages, options?)` | Same for any `CallTree`                                         |
| `callGraph(model, view, options?)`                            | `CallGraph` nodes and edges; layout is the UI's job (ELK)       |
| `functionRows(model, view, options?)`                         | `FunctionRow[]` for the functions table                         |
| `sandwich(model, view, fn)`                                   | `Sandwich`: callers (inverted) and callees as flame layouts     |
| `functionSource(model, view, fn)`                             | `FunctionSourceInfo`: per-line self time, call sites, sparkline |
| `timelineLane(model, trackIndex, options?)`                   | `TimelineLane`: CPU buckets, task blocks, GC and loop markers   |
| `relatedIds(model, view, selection)` / `hoverRelated`         | `RelatedIds` to highlight in each view                          |

Behavior worth knowing:

- **Inverted views.** `waterfallForTask`, `waterfallForRange` and `functionSource` need the call-order tree, so
  they rebuild an inverted view from the same stack without its `invert` step.
- **Waterfall.** Rows come from spans rebuilt from the view's samples, so the transform stack decides
  what a row is (plumbing merged, dependencies collapsed, idle dropped). Rows are in execution order
  (`start`, then `depth`), with `parent`, `selfUs`, `share`, `critical` (widest child at each level,
  `criticalPath` root first), `hatched` (< 2 sampling intervals) and a minimap of busy fractions. With
  async edges out of the task, `kind: 'wait'` rows carry labels such as `idle wait ~8 ms` and the
  scheduled task's rows follow one level deeper. Without async data none of that is emitted.
- **Flame graph.** `sort: 'left-heavy' | 'alphabetical'`, `orientation: 'icicle' | 'classic'` (use
  `row`), `zoomNode` (returns `zoomPath`), `colorBy: 'origin' | 'self' | 'diff'`. Diff coloring needs
  `options.diff` from `diffModels` and fills `change` (-1 faster, 1 slower, 2 new) and `intensity`.
- **Call graph.** One node per function; opens on the smallest set covering 80% of self time, at most 25
  nodes; `hiddenCallers` and `hiddenCallees` are the "+N" chips; `expanded` reveals neighbours; `ego`
  shows 2 callers up and 2 callees down and fades the rest; recursion is `node.recursion` plus `back`
  edges, never duplicate nodes.
- **Functions table.** Sort keys `self | total | name | calls | origin | package | file`, search over
  name, file and package, user code first by default. `calls` is an estimate from contiguous sample runs.

### Selection

```ts
type Selection =
  | { kind: 'function'; fn }
  | { kind: 'node'; path }
  | { kind: 'span'; trackIndex; span }
  | { kind: 'task'; trackIndex; task }
  | { kind: 'range'; start; end };
```

## Determinism

Every sort has an explicit tie-breaker, paths are '/'-normalized, and nothing reads a clock or a random
source, so snapshots are stable across platforms.

## Performance

Measured on the development machine (Windows laptop, Node 24), 60 s at 1 ms (60 000 samples, about 3 000
call nodes). `test/benchmark.test.ts` asserts generous bounds and writes these numbers when
`PACES_BENCH_OUT` is set.

| Stage                                 | Realistic profile | Worst case (unrelated stacks) | Spec target |
| ------------------------------------- | ----------------- | ----------------------------- | ----------- |
| `analyze`                             | ~70 ms            | ~290 ms                       | 1.5 s       |
| default transform stack               | ~5 ms             | ~35 ms                        | 50 ms       |
| `serializeModel` / `deserializeModel` | ~3 ms / ~1.5 ms   |                               |             |

## Tests and fixtures

Passes are tested against real captures of the zoo apps in `test/fixtures/` (see the README there).
Tiny synthetic captures (`test/helpers/synth.ts`) cover edge cases of a single pass only.

```bash
pnpm --filter @pacesjs/engine test
pnpm fixtures hot-regex   # regenerate one zoo capture
```
