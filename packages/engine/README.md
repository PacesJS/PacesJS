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

| Export                                              | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `analyze(capture, options?)`                        | Runs the ten passes. Pure and deterministic. Missing data degrades with a warning in `model.meta.warnings`, never an error.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `serializeModel(model)` / `deserializeModel(bytes)` | Compact binary: JSON header, typed array buffers (8-byte aligned, shared arrays stored once), engine-version stamp. `deserializeModel` throws `ModelVersionError` when the engine version differs (re-analyze the capture); `readModelEngineVersion(bytes)` reads the stamp alone.                                                                                                                                                                                                                                                                           |
| `buildAgentSummary(model)`                          | JSON-serializable digest (`schemaVersion: 2`): `target`, `runKind`, `primaryTrack`, findings with source locations, `topSelf` (25 functions by self time with origin, package, file:line, share), `hotPaths` (top 8 chains), `packages` (self/total plus each package's top 3 functions), `phases` (startup, config loading, main work, waiting, with durations and hottest functions), `caveats` (aggregated warnings), task statistics. Enough to answer "where is the time going in the target's code and which plugin functions are hot" without the UI. |
| `diffModels(base, head)`                            | Differential data (v1.x). Functions match by `functionKey`: project-relative original path, function name and original line. Never minified positions.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `DEFAULT_THRESHOLDS`                                | The finding thresholds from the design doc (see below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `applyTransforms`, query functions                  | The query layer, below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

```ts
interface AnalyzeOptions {
  thresholds?: Partial<Thresholds>;
  /** Regex source -> origin ('user' | 'dependency' | 'framework' | 'node' | 'native'),
   *  tested against the normalized original file path. Overrides the built-in rules. */
  classification?: Record<string, OriginName>;
  /** Regex sources tested against `<file>#<function name>`; a match marks plumbing. */
  plumbingPatterns?: string[];
  /** Explicit target: package names and path globs; replaces the package derived from the entry script. */
  focus?: string[];
  /** Override the detected run kind. */
  runKind?: 'server' | 'cli' | 'script';
  /** Finding kinds dropped for non-server runs (default event-loop-lag, event-loop-blocked). */
  suppressForCli?: FindingKind[];
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

### Target, track roles and run kind

`analyze` first works out **what is being profiled**, because the program is often itself an npm package
(`npx eslint .` runs `node_modules/.pnpm/eslint@9/node_modules/eslint/bin/eslint.js`).

- **Entry script** of each track: `TrackInfo.argv[1]` when the host recorded it (`argv` and `cwd` are
  optional fields of `TrackInfo`; the collector writes them to `<track>.info`, `readCaptureDir` must copy them
  over), else the first loaded `file:` script that is not paces' own preload. Workers always use their first
  script (they share the process's argv). `Track.entry` and `ExecutionModel.target.entry` are project-relative
  inside `meta.projectRoot` and faithful absolute paths with the drive letter (`C:/Users/...`) outside it.
- **Target package.** When the primary entry lives in `node_modules` (pnpm `.pnpm/<name>@ver/node_modules/<name>/`,
  flat npm/yarn, scoped, Windows global `AppData/Roaming/npm/node_modules/<pkg>`), that package is the target:
  its functions get `origin: user` and keep `pkg`, so views can still show the package name. Its other
  dependencies stay `dependency` (so `collapse-dependencies` still groups them, expandable). Otherwise the
  target is the project and `target.packages` is `[]`. `AnalyzeOptions.focus` overrides this with package
  names and path globs (`src/**`, matched against the stored file path). `collapse-dependencies` never collapses
  user-origin frames, so the target package stays visible.
- **paces' own instrumentation** (`.../paces/dist/preload.cjs`, `@pacesjs/collector-node/dist/preload.cjs`,
  `packages/collector-node/dist/preload.cjs`) is `origin: node` + `plumbing`, never `user`.
- **Roles.** `Track.role` is `'target'` or `'support'`. Support: a process whose entry is a known launcher
  (npx, npm, pnpm, yarn, corepack, cross-env, npm-run-all, concurrently...; by file name or by package), or
  one that used under 10% of the busiest process's busy time and (transitively) spawned another track.
  `ExecutionModel.primaryTrack` is the busiest non-support process (workers stay its children and share its
  role). If only launchers were profiled, the busiest is the target.
- **Labels.** `eslint · pid 128952` (package name, else script name), `npx · pid 128196 (supporting)`,
  `worker 1 · thread 1`. Without an entry the collector's label is kept.
- **`meta.runKind` / `target.kind`**: `server` when request events exist or `net`/`http` `listen` was seen in a
  target track; else `cli` when the entry is in `node_modules` or the command has arguments; else `script`.
  `AnalyzeOptions.runKind` overrides.

```ts
interface TargetInfo {
  packages: string[];
  entry: string;
  kind: 'server' | 'cli' | 'script';
}
```

### Warnings

`meta.warnings` is `ModelWarning[]` with one entry per `kind`:
`{ kind, severity: 'info' | 'warn', summary, count, details: string[] (at most 20) }`. Kinds: `no-profile`,
`invalid-pattern`, `invalid-focus`, `source-map-invalid`, `source-map-missing` (**warn**: a declared map is
missing for the target's own code) and `dependency-source-map-missing` (**info**: "N dependency files have no
source map; names are generated names, which is expected", details are `pkg/path` samples).

### Module loading

CommonJS and ESM loader frames (`node:internal/modules/*`, `Module._load`, `wrapModuleLoad`, `require`,
`compileFunction`, ...) are `plumbing` and `FunctionTable.loader = 1`. The top-level function of every loaded file
(anonymous, line <= 1, column 0) is renamed `require ▸ <path>` (`import ▸` for `.mjs`/`.mts`), where the path is
`pkg/path/inside/pkg.js` for `node_modules` files and project-relative otherwise, and gets `loader = 1` but is
not plumbing. With plumbing merged a require chain is one row per module, nested requires as children, total
time = load time. Loader frames do not count toward the `async-overhead` finding.

### Tasks

Task labels are `<kind> · <first frame of the target's code>`: `main · load eslint/bin/eslint.js`,
`request · GET /orders`, `timer · flushMetrics`, `microtasks · Linter.verify`, `I/O · readAndVerifyFile`,
`immediate · ...`, `other · ...`. `describeTasks(model, trackIndex): TaskDescriptor[]` returns
`{ index, group: 'Entry' | 'Requests' | 'Timers' | 'I/O' | 'Microtasks' | 'Other', label, startUs, durationUs,
busyUs, longest }`, ordered by group then duration (descending). The first main task is the `Entry` group
and is named from `track.entry`; `longest` marks the single longest task of the track. `index` is the index to
pass to `waterfallForTask`.

### Hot paths, package breakdown, callers

```ts
hotPaths(model, trackIndex, { limit = 8, minShare = 0.02, origin? }): HotPath[]
packageBreakdown(model, trackIndex, pkg): PackageFunction[]   // { fn, name, file, line, self, total }, by self desc
callersOf(model, trackIndex, fn, depth = 2): CallerNode[]     // { fn, name, file, line, weightUs, calls, callers[] }
```

`hotPaths` merges plumbing and idle (and, with `origin`, every other origin, so dependency time folds into the
calling target function) and returns chains that end where no callee still carries `minShare` of busy time,
ranked by total time: `{ fns, locations: {name, file, line}[], selfUs, totalUs, share }`. The first chain is the
dominant one. `packageBreakdown(model, i, 'eslint-plugin-react-hooks')` answers which functions of a dependency
(or of the target package) are hot. `callersOf` follows the function-level call edges, heaviest first, cutting
recursion.

### Embedded source

`getEmbeddedSource(model, capture, file)` returns the original text of `file` (a model file path or its
`StrId`) from the source maps' `sourcesContent`, or `undefined`. The model does not hold source text; the host
passes the capture it already has (`tracks` and `sourceMaps`), the first call parses the maps once, later calls
are map lookups. Use it when the file is not on disk.

### Breaking changes (UI and CLI)

- `meta.warnings` is `ModelWarning[]` (was `string[]`); `meta.runKind` is new.
- New required fields: `FunctionTable.loader`, `Track.role`, `Track.entry`, `ExecutionModel.target`,
  `ExecutionModel.primaryTrack`; new `FindingKind` `'hot-path'`.
- Task labels changed (`request · GET /orders`, `main · load ...`); function names of module top-levels changed
  (`require ▸ ...`).
- `buildAgentSummary`: `schemaVersion: 2`, `hotPaths` and `packages` changed shape, `warnings` is derived from
  the new `caveats`.
- paces' preload frames are `node` + plumbing (were `framework`).
- The transform tag is `kind` like every other transform: `{ kind: 'hide-origins', origins }`.
- `ENGINE_VERSION` is `0.2.0`: cached models from 0.1.0 are rejected by `deserializeModel`.

### Findings

Pure rule functions; each finding has one sentence with a number, evidence function ids, a `showMe`
target and a `rule` string that echoes the thresholds. `summary` names the function with `name (file:line)`
(`node_modules` paths shown as `pkg/path`). Rules only look at `role: 'target'` tracks. For `cli` and `script` runs
`event-loop-lag` and `event-loop-blocked` are dropped (`suppressForCli`), the target package is never a
`hot-dependency`, and dependencies are judged over the whole run (a command has only startup). Startup (`TaskKind.Main`) tasks are excluded from
rules about blocking, dependencies, plumbing and module loading, because every program loads code.

| Kind                  | Default trigger                                                                                                                                           | `showMe`                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `event-loop-blocked`  | A non-startup task longer than 50 ms                                                                                                                      | waterfall, longest task, `criticalPath`                                                                |
| `sync-io`             | `fs`, `child_process`, `zlib`, `crypto` `*Sync` inside a request or timer task, at least 5 ms in total (module loading is reported separately)            | waterfall, user caller, its line                                                                       |
| `hot-function`        | A user function above 10% of busy time (native frames it calls count as its own; one finding per function across tracks)                                  | functions, hottest line                                                                                |
| `hot-path`            | Command or script only: the deepest chain of target code (dependency time folded into the caller, module loading skipped) still carrying 10% of busy time | flame, `fn` = last frame, `options.zoomPath` = comma-separated function ids from the root's child down |
| `hot-dependency`      | An npm package above 20% of busy time outside startup (whole run for commands), not counting its plumbing or the target package                           | call graph, `expandPackage`                                                                            |
| `gc-pressure`         | GC above 10% of wall time, or a pause above 50 ms                                                                                                         | timeline range, `gcMarkers`                                                                            |
| `async-overhead`      | Plumbing self time above 15% of a task kind's busy time (the kind losing the most time is reported)                                                       | flame, `unmergePlumbing`                                                                               |
| `heavy-serialization` | `JSON.parse` or `JSON.stringify` above 5% of busy time                                                                                                    | functions, `search: 'JSON'`                                                                            |
| `late-module-loading` | The module loader inside request tasks, at least 5 ms in total                                                                                            | waterfall at the load                                                                                  |
| `event-loop-lag`      | p99 loop delay above 100 ms                                                                                                                               | timeline, `delayLane`                                                                                  |

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
  | { kind: 'collapse-dependencies' }       | { kind: 'merge-plumbing' } | { kind: 'drop-idle' }
  | { kind: 'hide-origins'; origins: OriginId[] };

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
- `hide-origins` merges frames of the given origins (`Origin.Dependency`, `Node`, `Native`, `Gc`, ...; collapsed
  package nodes count as dependencies) into their nearest kept caller, so their self time moves up. The root is
  never hidden. The default stack is unchanged; `collapse-dependencies` skips user-origin frames, so the target
  package is never collapsed.
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
- **Waterfall options.** `hideOrigins?: OriginId[]` (applied as an extra `hide-origins` step), `minDurationUs?`
  (drops shorter rows with everything beneath them) and `sort?: 'time' | 'duration' | 'share'` (orders siblings;
  default `'time'`). Rows stay in depth-first order and `id` stays the row's index, also after `maxDepth`,
  filtering and sorting (`parent` and `criticalPath` are renumbered).
- **Flame graph.** `sort: 'left-heavy' | 'alphabetical'`, `orientation: 'icicle' | 'classic'` (use
  `row`), `zoomNode` (returns `zoomPath`), `colorBy: 'origin' | 'self' | 'diff'`. Diff coloring needs
  `options.diff` from `diffModels` and fills `change` (-1 faster, 1 slower, 2 new) and `intensity`.
- **Call graph.** One node per function; opens on the smallest set covering 80% of self time, at most 25
  nodes; `hiddenCallers` and `hiddenCallees` are the "+N" chips; `expanded` reveals neighbours; `ego`
  shows 2 callers up and 2 callees down and fades the rest; recursion is `node.recursion` plus `back`
  edges, never duplicate nodes.
- **Functions table.** Filters `origins?: OriginId[]` and `pkg?: string` (a collapsed package row has that `pkg`). Sort keys `self | total | name | calls | origin | package | file`, search over
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

| Stage                                              | Realistic profile      | Worst case (unrelated stacks) | Spec target |
| -------------------------------------------------- | ---------------------- | ----------------------------- | ----------- |
| `analyze`                                          | ~70 ms                 | ~290 ms                       | 1.5 s       |
| default transform stack                            | ~5 ms                  | ~35 ms                        | 50 ms       |
| `serializeModel` / `deserializeModel`              | ~3 ms / ~1.5 ms        |                               |             |
| `hide-origins` on top of the default stack         | ~7 ms                  |                               | 50 ms       |
| `hotPaths` / `describeTasks` / `buildAgentSummary` | ~9 ms / ~2 ms / ~15 ms |                               |             |

## Tests and fixtures

Passes are tested against real captures of the zoo apps in `test/fixtures/` (see the README there).
Tiny synthetic captures (`test/helpers/synth.ts`) cover edge cases of a single pass only.

```bash
pnpm --filter @pacesjs/engine test
pnpm fixtures hot-regex   # regenerate one zoo capture
```
