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

### Timed call trees and selectors

```ts
callTreeQuery(model, trackIndex, { from?, depth = 6, minUs?, minShare = 0.01, sort = 'total',
  origins?, expandPkgs?, collapseDeps = true, task = 'whole', maxRows? }): TreeResult
resolveSelector(model, trackIndex, text): { matches: { fn, path?, totalUs }[]; how: 'exact' | 'path' | 'location' | 'id' | 'substring' }
```

`callTreeQuery` returns depth-first rows `{ id, fn, depth, name, file, line, origin, pkg, synthetic, totalUs,
selfUs, share, folded? }` on the same transform stack as the UI (`stitch-continuations`, `merge-plumbing`,
`drop-idle`, then `collapse-dependencies`), so numbers match the views. Details:

- `from` (a resolved selector) roots the tree at that function (all call sites merged) or, with `path`, at one
  call chain. `share` is relative to the whole view (the run, or the task); `minShare`/`minUs` and
  `depth` are relative to the root row. Rows below the threshold or past `depth`/`maxRows` are not returned;
  `folded` on a row counts the descendants left out and `TreeResult.hidden` the total.
- `sort: 'time'` orders siblings by first sample time (execution order), `'self'` by self time.
- `origins` keeps only those origins (hidden frames fold into their nearest kept caller, like the UI's Show
  filter). `expandPkgs` keeps those packages uncollapsed while the other dependencies stay collapsed
  (`synthetic: true`, id `p:<pkg>`); `collapseDeps: false` shows everything. `task` is a task index of the
  track (a `time-range` after stitching).
- Function ids are `f<index in model.functions>`. The table is deterministic for a capture and engine
  version, so ids are valid for the same session file (also after reopening it from the model cache) and
  across invocations; they are not comparable between sessions or engine versions. Stitched entry roots
  have ids too.
- Selectors: `f123`; `path/suffix.js:1007` (definition line; a line inside a function resolves to the nearest
  definition above it); `a,b,c` (each step a descendant of the previous, exact names if any exist, else
  substring; one match per distinct last function, carrying the heaviest chain as `path`); a name (exact,
  else substring; `(anonymous)` matches unnamed functions). Case-sensitive. Matches are sorted by total time.

### Embedded source

`getEmbeddedSource(model, capture, file)` returns the original text of `file` (a model file path or its
`StrId`) from the source maps' `sourcesContent`, or `undefined`. The model does not hold source text; the host
passes the capture it already has (`tracks` and `sourceMaps`), the first call parses the maps once, later calls
are map lookups. Use it when the file is not on disk.

### Continuation stitching and the run root

A sampled profile has no async parents. After its first `await`, an async function resumes as a promise
continuation: V8 records that stack rooted at the runtime (`processTicksAndRejections`, a timer, an I/O
callback), not under the function that called it. The engine infers the logical parent instead.

- **Pass (`passes/continuations.ts`).** For each task, in time order, every distinct resumed function (the
  shallowest non-runtime, non-plumbing frame of a stack in the task) is a _segment_. Its source is the latest
  earlier span of the _same function id_ (same file, line and column, never just the same name) that ended
  before the segment started and has a caller (`depth >= 1`); ties prefer the latest, then the deepest. The
  logical parent is that span's parent, resolved through chains: if the earlier span was itself a stitched
  segment, its logical parent is reused. With `--async` data, a real edge from the scheduling task wins
  (`stitch = 2`); otherwise `stitch = 1`.
- **Data.** `TaskTable` gains `parentSpan` (-1 = none, attach to the run root), `resumeOf` (the earlier span being
  resumed), `waitUs` (gap between that span's end and the resumption: the awaiting time), `stitch`
  (0 none, 1 inferred from an earlier call, 2 exact from async hooks, 3 attached where the previous task yielded), `resumedFn` (-1 when the task has no program frame) and `runtimeOnly` (1 when it
  only runs runtime or plumbing frames). They describe the task's first segment. `Track.continuations`
  (`ContinuationTable`) has one row per stitched segment (`task`, `fn`, `span`, `parentSpan`, `resumeOf`,
  `waitUs`, `stitch`). Tasks with several resumed functions in a row (an inner async function finishing, then
  its caller resuming) have several rows.
- **Run root.** `Track.rootFn` is a function row named after the entry script (`eslint/bin/eslint.js`, origin
  `user`, `pkg` set for a package target). It never appears in a raw call tree; it is the root of stitched views.
- **Transform** `{ kind: 'stitch-continuations' }` (default-on, first in `DEFAULT_TRANSFORMS`; chip label
  "Stitch continuations (inferred)"). It grafts the samples of each stitched segment under the logical parent
  path and puts every stack under one top frame, `rootFn`, so views start at the entry: `(root) > entry >
module load, main, unstitched roots...`. Self and total time and the sample count are preserved. It reads the
  track's own tree, so it only works as the first step; elsewhere in the stack it does nothing. Flame graph,
  call graph, functions table, source panel and `hotPaths` all read the stitched tree. `hotPaths` leaves the
  root out of its chains.

Limits, honestly. This is inference. (1) A function that was called but never sampled before its first
`await` (a short synchronous prelude under one sampling interval) leaves no earlier span, so its
continuation stays an unstitched root under the entry. (2) A function called from several places that resumes
as a fresh callback can be attached to the wrong earlier call (the latest one wins). (3) A callback that is
the task's entry on every run (a timer function) has no caller to attach to and stays a root. (4) Awaits
shorter than one sampling interval do not split a call, so no segment exists for them.

### Bridged runtime samples

V8 reports `(program)` (native time with no JS stack) and `(garbage collector)` as separate root children. A call
that is really continuous then looks like several calls split by a root-level sample, and every view drew each
piece as its own row. Right after ingest, `analyze` re-attaches a run of such samples that sits between two samples
whose stacks share a prefix as a leaf child of the deepest shared frame (`AnalyzeOptions.bridgeRuntimeSamples`,
default `true`). The call stays one span, and the pause appears nested under the running call. Only the parent
of those samples changes: sample count, durations, self and total time, busy time and the `Native` / `Gc`
classification are unchanged. If the stacks before and after share nothing (a task boundary), the run touches
`(idle)`, or the pause is at the start or end of the profile, it stays at the root as before.

### Attaching a continuation where the previous task yielded (`stitch = 3`)

When a continuation has no earlier call of its function to resume (the synchronous first part was shorter than one
sample, so there is no span), it is attached where the previous task yielded, best effort and labelled
`stitch = 3` ("attached to where the previous task yielded (inferred)"):

- Only for tasks of kind `main`, `microtask` or `other`, and not for a module load (a loader frame is a root:
  dynamic imports of plugins). Timer, I/O and request entries have no caller.
- The parent task is the exact async edge into the task with the smallest wait (ties: the latest scheduler), at any
  gap; without async data, the nearest earlier task that has program frames, if it ended within two sampling
  intervals of this task's start. A longer gap stays unattached: nothing says the two are related.
- Its attachment point is the parent task's last sampled stack: the last run of module-loading frames (unless
  it starts the stack, which is the entry module wrapping the program) and everything below it is dropped, then
  runtime and plumbing frames; the deepest remaining target (origin `user`) frame wins, else the deepest remaining
  frame. If nothing is left, the task stays a root.
- The parent is always an earlier span, so the attachment can never form a cycle or point at a descendant.
  `ContinuationTable.resumeOf` is -1 and `waitUs` is the gap after the parent task ended.

In the whole-run waterfall a stitched call's callers are one row each (touching rows of the same call under the
same parent are merged, so the entry module and `main` appear once, spanning the run). A resumed call keeps its
own row with `resumed: true` and an `awaiting` row before it, as a sibling inside its caller's row. A `stitch = 3`
call is a new call under its caller: it is not flagged `resumed`, but gets the awaiting row.

### Whole-run waterfall

`waterfallForRun(model, trackIndex, options?)` returns the same `Waterfall` as the task waterfall, for the whole
run, on the stitched tree (`options.transforms`, default `DEFAULT_TRANSFORMS`). Row 0 is the entry root, one row
covering the run; nested rows are logical calls in time order. Options: `hideOrigins`, `minDurationUs`, `sort`
(as the task waterfall), `maxDepth`, plus `collapseTrivialUs`.

- A call that continues after an `await` is another row (segment) of the same call, with `resumed: true`
  (also set on callers that resume at the same instant), and an idle row `kind: 'wait'`, label
  `awaiting ~7.0 ms`, between the segments at the level of the topmost resumed caller. Waits shorter than
  one sampling interval are not drawn.
- Small tasks (`trivialTasks(model, trackIndex, thresholdUs?)`): busy time below `collapseTrivialUs` (default the
  larger of 0.5 ms and 0.1% of the run), or only runtime frames (`runtimeOnly`), except the entry task. They
  make no rows. Each run of consecutive small tasks becomes one `kind: 'summary'` row under the root,
  `"N small tasks · ~X ms"`, with `summaryTasks` listing the task indexes; expand a summary by opening those
  tasks with `waterfallForTask`. `collapseTrivialUs: 0` turns collapsing off.
- New row fields: `resumed: boolean`, `summaryTasks: number[]` (empty except on summary rows); `kind` is
  `'call' | 'wait' | 'summary'`. Ids stay indexes, parents come before children.

`describeTasks` starts with `{ index: -1, group: 'Whole run', label: 'Whole run · <entry>' }` (open it with
`waterfallForRun`), then `Entry`, `Requests`, `Timers`, `I/O`, `Microtasks`, `Other`, and last `Small tasks`.
Every descriptor has `trivial: boolean`; trivial tasks are listed under `Small tasks`.

### Call graph roots

`callGraph` always draws the stitched entry root first (`node.isEntry`, callers above callees). Pruning keeps
every drawn node connected: an edge goes from the nearest drawn ancestor, with `edge.hiddenFrames` = pruned frames
in between (0 = a direct call; > 0 draws dashed, "via N frames"). Recursion is `node.recursion`, never a self
edge.

### Function source info

`functionSource` adds `definitionLine` (1-based definition line, 0 for collapsed packages), `hotLines` (lines with
self time, most first), `calleeTime` (`{ fn, name, pkg, selfUs, totalUs }` of the callees under this function,
largest first; `line` is never set, because sampled profiles carry no call-site line) and
`lineInfo: { status: 'self-lines' | 'no-self-time' | 'no-line-data', reason }`: `no-self-time` means the function
itself ran little and its time is in its callees; `no-line-data` means V8 recorded no line positions
(inlined, native, a collapsed package). Definition lines are verified against the real sources of the orders
server (source-mapped TypeScript) and eslint (class methods, constructors, arrows, anonymous functions).

### Breaking changes (UI and CLI)

- `meta.warnings` is `ModelWarning[]` (was `string[]`); `meta.runKind` is new.
- New required fields: `FunctionTable.loader`, `Track.role`, `Track.entry`, `ExecutionModel.target`,
  `ExecutionModel.primaryTrack`; new `FindingKind` `'hot-path'`.
- Task labels changed (`request · GET /orders`, `main · load ...`); function names of module top-levels changed
  (`require ▸ ...`).
- `buildAgentSummary`: `schemaVersion: 2`, `hotPaths` and `packages` changed shape, `warnings` is derived from
  the new `caveats`.
- paces' preload frames are `node` + plumbing (were `framework`).
- Second round: `TaskTable` has six new columns and `Track` has `continuations` and `rootFn`; the function table
  gets one appended row per entry script; `DEFAULT_TRANSFORMS` starts with `stitch-continuations`, so every
  default view is rooted at the entry function; `WaterfallRow` has `resumed` and `summaryTasks` and `kind` may be
  `'summary'`; `CallGraphNode.isEntry` and `CallGraphEdge.hiddenFrames` are required; `TaskDescriptor` has `trivial`,
  the first descriptor is the whole run (`index: -1`) and `TaskGroup` has `'Whole run'` and `'Small tasks'`;
  `FunctionSourceInfo` has `definitionLine`, `hotLines`, `calleeTime`, `lineInfo`; `hotPaths` leaves the entry
  root out of its chains.
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
  | { kind: 'hide-origins'; origins: OriginId[] }
  | { kind: 'stitch-continuations' };

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
| `waterfallForRun(model, trackIndex, options?)`                | `Waterfall` of the whole run on the stitched tree               |
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
