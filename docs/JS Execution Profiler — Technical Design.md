# JS Execution Profiler — Technical Design

Oct 15, 2026 · @Ilya Volodin

## Overview

The tool, working name **Trailmap**, wraps a Node command (`npx trailmap -- node app.js`), profiles it end to end, and opens a UI that shows what the JavaScript did in several linked views. Node ships first; the browser plugs into the same engine later.

**Problem.** V8 records excellent data, but every current presentation of it is hard to read. Flame charts drown in minified names and async plumbing, the link from a frame to its source is a detour, and Node's best readable tool, Clinic.js, has not shipped a release since June 2023.

**Goals**

- Make JavaScript execution easy to read and navigate, for people who think in flame graphs, waterfalls or call graphs.
- Zero setup: one command runs the target, captures everything, and shows the result when it finishes.
- One engine for Node and browser, with any number of presentation shells on top.
- Find bottlenecks fast, as a feature layered on top of good presentation, not a replacement for it.
- Install from npm with no native binaries.

**Non-goals for v1**

- Production or continuous profiling (APM vendors own that).
- Memory and heap analysis beyond GC pauses.
- Browser collection (designed for, not built).
- Hosted sharing or accounts. The project is free and open source.

**Principles**

1. Summary first, detail on demand. Every view opens on the few things that matter.
2. Your code first. Framework, library and async plumbing frames are folded by default and always expandable.
3. One model, many views. Every view is a projection of the same execution model, linked by selection.
4. Source is never more than one glance away. Code shows beside the data, not behind a link.
5. Honest data. Sampled timings are labelled as estimates; exact data comes only from instrumentation.

## Requirements

The five requirements set in the kickoff (R1 to R5) are fixed; the rest follow from them.

| ID | Requirement | Priority |
| --- | --- | --- |
| R1 | Engine and presentation are separate packages; the same engine serves Node and browser, and standalone and plugin UIs | Must, v1 |
| R2 | Node first; browser collection designed for but built later | Must, v1 |
| R3 | The CLI takes the target command as arguments, profiles the whole run, and opens the UI when the run ends; no manual profile files | Must, v1 |
| R4 | Cross-platform UI launched from the command line, without Electron's packaging burden | Must, v1 |
| R5 | Installable with `npm i -g` or runnable with `npx`; no native binaries or postinstall compile | Must, v1 |
| R6 | Analysis runs in the CLI process; the UI receives a finished model | Must, v1 |
| R7 | Several linked views over one model: waterfall, flame graph, call graph, functions table, source | Must, v1 |
| R8 | Source maps resolved before anything is shown | Must, v1 |
| R9 | Framework, library and async plumbing folded by default | Must, v1 |
| R10 | Child processes and worker threads captured as separate tracks | Should, v1 |
| R11 | Long-running servers: Ctrl+C stops profiling and opens the UI; the app still shuts down | Must, v1 |
| R12 | Sessions saved and reopenable; two sessions can be diffed | Should, v1.x |
| R13 | Findings: ranked plain-language bottleneck summary | Should, v1 |
| R14 | Machine-readable summary for coding agents (JSON and an MCP tool) | Could, v1.x |
| R15 | Opt-in instrumentation for exact call order and counts | Could, v2 |

**Non-functional**

- Overhead: under 5% wall-clock slowdown at the default sampling interval on a CPU-bound benchmark (target to verify in M1).
- Startup: UI visible within 2 seconds of the target exiting, for a 60-second profile.
- Runtime support: the active Node LTS lines at release; Linux, macOS and Windows.
- Privacy: nothing leaves the machine. No telemetry by default.

## Architecture

Three processes cooperate: the profiled target, the CLI that owns the engine, and a browser window that only renders. Collectors and shells are swappable; the engine and session format are the fixed middle.

&#91;embedded content: architecture · collector, CLI engine, UI shell\]

Data flows one way: raw chunks from the target, a finished model from the CLI, queries inside the UI. The dashed boxes plug into the same engine and UI bundle later.

**Packages** (pnpm workspace, Turborepo, TypeScript)

| Package | Role | Depends on |
| --- | --- | --- |
| `trailmap` | The published CLI; bundles everything below for `npx` | all |
| `@trailmap/collector-node` | Preload scripts, socket client, flush logic | Node built-ins only |
| `@trailmap/engine` | Passes, execution model, query and transform layer; no Node or DOM imports | none |
| `@trailmap/format` | `.tmap` read and write, version checks | engine types |
| `@trailmap/ui` | View bundle and the `HostAdapter` interface | engine query layer |
| `@trailmap/collector-browser` (v2) | CDP over WebSocket | none |
| `@trailmap/vscode` (v1.x) | Webview shell | ui |

A dependency-boundary check in CI keeps `engine` free of Node and DOM imports, which is what lets one engine serve both runtimes and every shell (R1).

## Node collector

The CLI spawns the target with a preload script injected through `NODE_OPTIONS`; the preload starts V8's CPU profiler in-process through `node:inspector`, records runtime events, and streams everything back to the CLI over IPC. No flags reach the user's command line and no files are written by hand.

**Spawn**

1. `trailmap [flags] -- <command...>` parses its own flags, then spawns `<command>` unchanged with `stdio: ['inherit','inherit','inherit','ipc']` so the target's terminal output looks normal.
2. The child environment gets `NODE_OPTIONS="--require <preload.cjs> --import <preload.mjs>"` appended to any existing value, plus `TRAILMAP_SESSION=<id>` and `TRAILMAP_SOCKET=<path>`.
3. Because `NODE_OPTIONS` is inherited, wrappers work unchanged: `npm run start`, `tsx`, `ts-node`, `nodemon`, test runners. Each Node process that loads the preload registers itself and becomes its own track (R10).
4. Non-Node processes in the tree are ignored; a run with zero registered Node processes ends with a clear error.

**Preload, per process**

- Opens an `inspector.Session` with `connect()` and sends `Profiler.enable`, `Profiler.setSamplingInterval` (default 1000 µs, the same as `--cpu-prof`; `--interval` to change), then `Profiler.start` before user code loads.
- Sends `Runtime.enable` and records `Debugger.scriptParsed` events with each script's URL and `sourceMapURL`, so the engine can resolve source maps for code that no longer exists on disk (eval, bundles built in memory).
- Subscribes to `perf_hooks` GC entries and `monitorEventLoopDelay` (histogram every 100 ms) for the GC and event-loop tracks.
- Worker threads: the preload runs inside each `Worker` too (workers inherit `execArgv` by default; confirm the preload runs there in M1); each worker opens its own session and reports with its `threadId`, becoming a sub-track of its process.
- Connects to the CLI over the socket in `TRAILMAP_SOCKET` (a Unix socket or a Windows named pipe), not the `ipc` fd, because grandchild processes do not inherit the fd.

**Async causality (opt-in in M1, default once overhead is measured)**

Sampled profiles record stacks, not which async operation scheduled which callback. The logical-flow views need that link. Node's `async_hooks.createHook` gives it (init with `triggerAsyncId`, before, after), but Node's own docs discourage it, list it as Stability 1, and warn of performance cost ([Node docs](https://nodejs.org/api/async_hooks.html)). The collector therefore:

- Uses `createHook` behind `--async` in M1, writing only `(asyncId, triggerAsyncId, type, timestamp)` into a preallocated ring buffer, with no stack capture and no allocation in the hot path.
- Measures overhead on the benchmark suite (see Testing). If it stays under the overhead budget, it becomes the default.
- Tracks Node's work on a purpose-built replacement and swaps the backend when one ships. The engine consumes the same event shape either way.

**Stopping and flushing**

- Normal exit, including `process.exit()`: the preload stops the profiler inside the `exit` handler, where only synchronous work runs. A main-thread inspector session dispatches synchronously (verify in M1), so the profile is written with `fs.writeFileSync` into the session directory. The socket carries live events and control messages only, never the final payload.
- Ctrl+C on a server (R11): the CLI catches SIGINT, sends `stop` to every registered process, waits up to 5 s for flushes, then forwards SIGINT so the app's own shutdown runs. A second Ctrl+C kills immediately.
- Crashes: the preload hooks `uncaughtException` only to flush, then rethrows so behavior is unchanged.
- `--duration <s>` and `--start-on <signal|route>` cover profiling a window of a long-running process.

**Overhead budget**

| Mode | What runs | Target slowdown |
| --- | --- | --- |
| Default | Sampling at 1 ms, GC and loop-delay events | under 5% |
| `--interval 100` | Sampling at 100 µs for sharper waterfalls | under 15% |
| `--async` | Plus async causality ring buffer | under 20% on promise-heavy code |
| Instrumented (v2) | Exact call entry and exit in chosen modules | reported, not capped |

The targets are hypotheses to confirm in M1; the session header records the mode so the UI can label estimates honestly.

## Browser provisions

The browser is not built in v1, but nothing in the engine or session format may assume Node. The rule: collectors speak the Chrome DevTools Protocol, because Node's inspector and Chrome or Edge expose the same `Profiler` and `Runtime` domains.

**Collector interface** (shared by both runtimes)

```ts
interface Collector {
  start(opts: CollectOptions): Promise<void>;
  stop(): Promise<void>;
  on(event: 'track', cb: (t: TrackInfo) => void): void;     // process, worker, page, frame
  on(event: 'chunk', cb: (c: RawChunk) => void): void;      // profile, events, scripts
}
type RawChunk =
  | { kind: 'cpuProfile'; track: TrackId; profile: CdpProfile }
  | { kind: 'scripts'; track: TrackId; scripts: ScriptInfo[] }
  | { kind: 'events'; track: TrackId; events: RuntimeEvent[] }; // gc, loop, async, render
```

**What the browser collector will add**

- Connection over CDP with a bare WebSocket (no Puppeteer dependency in the core). `trailmap browser <url>` launches Edge or Chrome with remote debugging; `--attach <port>` joins one already running.
- The `Tracing` domain with `devtools.timeline` categories, so style, layout and paint events land on the same tracks as JavaScript. This is what makes "rendering forced inside a script task" detectable, which a CPU profile alone cannot show.
- Import of a trace JSON exported from the DevTools Performance panel, through the same chunk shape.

**Reserved now so v1 does not block it**

- `RuntimeEvent` already has `render` and `network` variants, unused in Node.
- Track kinds include `page` and `frame`.
- Frame classification (yours, library, framework, runtime) keys on URL patterns, so `node_modules/` and `webpack://` bundles classify the same way.

## Session format

Every run is saved as one `.tmap` file (a zip) so it can be reopened, diffed and, later, shared. The raw capture is the source of truth; the analyzed model is a cache the engine can always rebuild.

**Layout**

```text
session.tmap
  manifest.json          format version, engine version, command, cwd, Node version,
                         platform, mode, sampling interval, start/end, tracks[]
  raw/<track>.cpuprofile V8 profile as returned by Profiler.stop
  raw/<track>.events     newline-delimited JSON: gc, loop delay, async, render
  raw/<track>.scripts    scriptId, URL, sourceMapURL, content hash
  sources/<hash>         optional: source text and source maps (--embed-sources)
  model/<engine-ver>.bin cached execution model; ignored if the engine version differs
```

**Rules**

- `manifest.formatVersion` follows semver. Readers accept any minor version of their major and refuse newer majors with a clear message.
- Default location is `./.trailmap/` with timestamped names; `--out <file>` overrides. The CLI prints the path on exit.
- Sources are referenced by content hash. When a file has changed since the run, the UI shows the code with a "changed since profiling" banner instead of silently showing the wrong lines. `--embed-sources` copies them in for sessions meant to travel.
- Diffing two sessions (R12) matches functions by a stable key: original file path relative to the project root, function name, and original line after source mapping. Minified positions are never used as keys.
- The model cache is a compact binary (columnar typed arrays plus a string table), written so a reopen skips analysis entirely.

## Engine

The engine turns raw chunks into one execution model through ten ordered passes in the CLI process (R6). Interactive queries over that model (transforms, filters, aggregations) run in a Web Worker inside the UI using the same engine package, so a click never waits on a round trip.

**Execution model**

```ts
interface ExecutionModel {
  meta: SessionMeta;                 // command, mode, interval, precision
  strings: string[];                 // shared string table
  functions: FunctionTable;          // one row per distinct function
  tracks: Track[];                   // process, worker (later: page, frame)
  findings: Finding[];
}
interface FunctionTable {            // columnar typed arrays
  name: Uint32Array; file: Uint32Array; line: Uint32Array; col: Uint32Array;
  origin: Uint8Array;                // user | dependency | framework | node | native | idle | gc
  pkg: Uint32Array;                  // npm package name, 0 for user code
  plumbing: Uint8Array;              // 1 = async or framework plumbing, folded by default
}
interface Track {
  id: TrackId; kind: 'process' | 'worker' | 'page' | 'frame'; label: string;
  callTree: CallTree;                // parent, fn, self, total per node
  samples: { time: Float64Array; node: Uint32Array };
  spans: SpanTable;                  // reconstructed calls: node, start, end, depth
  tasks: TaskTable;                  // top-level units of work with entry labels
  asyncEdges: AsyncEdgeTable;        // task -> task that scheduled it
  events: EventTable;                // gc, loop delay, (browser: render, network)
  lines: LineTicks;                  // per function: line -> self samples
}
```

**Passes, in order**

1. **Ingest.** Convert each CDP profile (nodes, samples, time deltas) into absolute timestamps and a raw call tree; keep V8's `positionTicks` for line-level self time.
2. **Source maps.** Resolve every frame to original file, line and name using the recorded `sourceMapURL`s (inline, file, or `webpack://`). Missing maps degrade to generated names with a warning badge, never an error.
3. **Classification.** Tag each function's origin: user code, dependency (`node_modules`, with package name), framework, Node internals (`node:` URLs), native, idle, GC. Rules are URL patterns plus a user override file.
4. **Plumbing detection.** Mark frames that only move control around: promise reaction jobs, `__awaiter` and regenerator steps, RxJS `Subscriber.next`/`complete`, `tslib` helpers, event-emitter dispatch. Ships with a curated list; users add patterns. Marked, never deleted.
5. **Span reconstruction.** Consecutive samples sharing a call path become spans with start and end. Precision is plus or minus one sampling interval, stored in `meta.precision` and shown in the UI.
6. **Task segmentation.** Split each track into tasks at idle gaps and runtime entry frames (`processTicksAndRejections`, `listOnTimeout`, `processImmediate`, I/O callbacks). Each task gets an entry label from its first meaningful user frame, plus known patterns (HTTP route for Node's `http` request handlers, timer, immediate, microtask).
7. **Async stitching.** When `--async` data exists, map tasks to async IDs by timestamp alignment of before/after hooks, and record which task scheduled which. Without it, the edge table is empty and the logical-flow features say so.
8. **Aggregation.** Self and total time per function, per call edge (caller, callee, weight, count estimate), per source line, per package, per task kind.
9. **Findings.** Rule-based detectors produce ranked, plain-language findings, each linked to model rows (see Data representation).
10. **Agent summary.** A compact JSON digest: top findings, hot paths with source locations, task statistics. Written into the session and served over an MCP tool later (R14).

**Transforms (interactive, in the UI worker)**

The UI applies a stack of transforms to the model; every view reads the transformed result, and the stack is visible and undoable. The set follows the Firefox Profiler's proven vocabulary ([docs](https://raw.githubusercontent.com/firefox-devtools/profiler/main/docs-user/guide-filtering-call-trees.md)):

| Transform | Effect |
| --- | --- |
| Merge function | Remove a function everywhere; its self time goes to callers |
| Merge node | Same, for one call node only |
| Focus on subtree | Keep one call node and its descendants |
| Focus on function | Keep every subtree rooted at a function, merged |
| Focus on function self | Keep only samples where the function is the innermost frame |
| Collapse package | Fold all frames of an npm package into one node |
| Collapse recursion | Fold recursive calls into one node |
| Drop samples | Remove samples containing a function (idle, a known warm-up) |
| Time range | Restrict to a selected window |
| Invert | Build the tree from leaves up, so self time sits at the roots |

Default stack on open: collapse every dependency package, merge plumbing frames, drop idle. The defaults appear as the first breadcrumbs, so a user can always see and remove them.

## Data representation

The UI opens on a findings summary above a track timeline, then offers five linked views of the same transformed model: waterfall, flame graph, call graph, function table and source. Your code is shown first, plumbing is folded, source is always docked beside the data, and one selection drives every view.

### What other tools teach

| Source | Lesson | How Trailmap applies it |
| --- | --- | --- |
| [Brendan Gregg, flame graphs](https://brendangregg.com/flamegraphs.html) | Flame graphs (x = population, merged) and flame charts (x = time) answer different questions; icicle layout is common | Ship both: aggregated flame graph and time-ordered waterfall; never mix their axes |
| [speedscope](https://github.com/jlfwong/speedscope) | Three views cover most needs: time order, left-heavy (heaviest stack leftmost), and sandwich (callers and callees of one function) | Left-heavy is the flame graph default; the function table has a sandwich panel |
| [Firefox Profiler](https://raw.githubusercontent.com/firefox-devtools/profiler/main/docs-user/guide-filtering-call-trees.md) | A named, composable set of transforms (merge, focus, collapse, drop) tames huge trees | Same vocabulary, shown as breadcrumbs (Engine section) |
| [Datadog Continuous Profiler](https://www.datadoghq.com/blog/profiling-visualizations/) | Users misread category colors as good or bad and assumed left-to-right meant time; a call graph shows a function's total impact that a flame graph scatters; pruning plus "+" expansion makes graphs approachable; menus above the chart act as a legend | No red or green for anything but finding severity; axis label on every view; call graph pruned with expand buttons; color and sort menus double as the legend |
| [Chrome DevTools](https://developer.chrome.com/blog/devtools-navigate-and-filter) | Ignore lists collapse library scripts; "dim 3rd parties" cuts clutter | Dependencies collapsed by default; non-user frames dimmed, never hidden |
| [Jaeger and Honeycomb](https://docs.honeycomb.io/reference/honeycomb-ui/query/trace-waterfall) | Waterfalls are read by following the widest child at each level (the critical path); a condensed summary strip helps find long spans without scrolling | Critical path highlighted in the waterfall; a minimap strip above it |
| [Perfetto UI docs](https://flutter.googlesource.com/third_party/perfetto/+/refs/heads/master/docs/visualization/perfetto-ui.md) | Pinned tracks and area selection that feeds an aggregate table | Pin tracks to the top; drag a range on the timeline to scope every view |
| [ESEM 2015 study, 12 developers](https://arxiv.org/pdf/1706.10118) | Profiling data shown in the source view largely replaced the list view; developers navigate by following dynamic calls | Source panel always docked; call sites in source are clickable and show time spent in the callee |
| [EasyView (IDE profiler study)](https://arxiv.org/pdf/2312.16598) | Integrating profiles into the editor flattened the learning curve, including for non-experts | Same UI bundle targets a VS Code webview later |
| [Clinic.js](https://github.com/clinicjs/node-clinic) | Diagnose first, then route to the right specialized view | Findings panel first; each finding opens the view that proves it |
| [dynaTrace AJAX Edition (2009)](https://www.stevesouders.com/blog/2009/09/30/dynatrace-ajax-edition-tracing-js-performance/) | Time broken out by triggering event and by library; minified code shown prettified | Tasks labelled by trigger; time by package; source maps, then prettify as fallback |

Three principles fall out of this: show **summary before detail**, make **every encoding explicit** (labelled axes, legends, units), and keep **one selection across all views**.

### Screen layout

One screen with four fixed zones; nothing opens in a new window and nothing hides the selection.

1. **Header bar:** command, duration, mode and precision badge ("sampled, ±1 ms"), track picker, search, and the transform breadcrumbs.
2. **Overview band (top):** the findings strip, then one lane per track showing CPU activity, tasks as blocks, GC and event-loop-delay markers. Dragging across it sets the time range for every view. Tracks can be pinned.
3. **Main view (center):** tabs for Waterfall, Flame graph, Call graph and Functions, switched with keys 1 to 4. Each tab keeps its own scroll and zoom.
4. **Source panel (right, docked):** the selected function's source with a time gutter. Collapsible, never a separate page.

A details drawer under the main view shows the selected item's numbers: self, total, share of track, call count (estimated or exact), origin, and its callers and callees.

&#91;embedded content: screen layout wireframe: header, overview band, main view, details drawer, source panel\]

The wireframe is illustrative: bar positions carry no data. What it fixes is the placement, so the selection, the findings and the source are always on screen together.

### The views

Each view answers one question. The table is the contract; the subsections set the encoding.

| View | Question it answers | Axis | Default |
| --- | --- | --- | --- |
| Findings | What should I look at first? | Ranked list | Top 5, severity-ordered |
| Track timeline | When was the process busy, and with what? | Time | Whole run, all tracks |
| Waterfall | What happened, in order, inside this task? | Time | Longest task selected |
| Flame graph | Where does time go overall? | Population (merged stacks) | Left-heavy, icicle (root on top) |
| Call graph | Which functions dominate, and who calls them? | None (graph) | Pruned to the nodes covering 80% of time |
| Functions | Which functions are most expensive, and through which callers? | Table | Sorted by self time, user code first |
| Source | Which lines are slow? | Lines | Selected function, hottest line scrolled into view |

#### Waterfall

The waterfall is the reading view for one task or time range: rows are calls in execution order, indented by depth, each with a bar on a shared time axis, as in a network panel or a Jaeger trace.

- **Rows.** One row per reconstructed span: function name, `file:line`, duration and share of the task. Plumbing frames are merged into their parent row by default, so an `async` chain reads as one call.
- **Logical flow.** With async data, work scheduled by a call appears as child rows under it, joined by a dashed connector across the wait. A gap between rows is idle wait, labelled with its length.
- **Critical path.** At each level the widest child is outlined; pressing `p` collapses everything else, leaving the chain that set the task's duration.
- **Minimap.** A thin strip above the rows shows the whole task with the visible window outlined, as Honeycomb's trace summary does.
- **Precision.** Bars shorter than two sampling intervals are drawn hatched and labelled "< 2 ms"; durations carry a "\~" prefix in sampled mode.
- **Navigation.** Arrow keys walk rows; Enter opens source; `f` focuses the subtree; Backspace goes back.

#### Flame graph

The flame graph answers "where does time go" with stacks merged across the whole range.

- Icicle layout (root on top) by default, a toggle for classic upward flames.
- Sort menu: **left-heavy** by total time (default) or alphabetical for stable comparison. The menu sits above the chart with an axis caption, "width = share of samples, order = heaviest first, not time", answering Datadog's finding that users assume left-to-right is time.
- Color menu: **by origin** (default) or **by self time** as a single-hue gradient. Both menus double as the legend.
- Click zooms into a frame; the zoom path is a breadcrumb.
- **Differential mode** (two sessions): width from the newer run, hue from the change, blue for faster and orange for slower (color-blind safe), intensity by size of change.

#### Call graph

The call graph shows each function once, so a function called from forty places shows its full cost in one box instead of forty slivers.

- **Encoding.** Node area and fill intensity = self time; a bar inside the node = total time; edge thickness = time passed from caller to callee; edge label = share and estimated call count.
- **Pruning.** Opens with the smallest node set covering 80% of total time (capped at 25 nodes). Hidden callers or callees show as a "+N" chip on the node; clicking it reveals them, as in Datadog's design.
- **Ego mode.** Selecting a function re-centers the graph on it: callers two levels up, callees two levels down, everything else faded.
- **Grouping.** With "collapse package" active, a dependency becomes one node labelled with the package name, expandable in place.
- **Layout.** Layered, top-down (callers above callees), computed with ELK in a worker. Cycles and recursion are drawn as a back-edge loop with a count, never as duplicate nodes.
- **Stability.** Positions persist across selection changes so the picture does not jump; only fading and highlighting change.

#### Functions table and sandwich

A sortable table of every function: name, origin, package, self time, total time, share, estimated calls, `file:line`. Selecting a row opens the sandwich: an inverted mini flame graph of its callers above and a flame graph of its callees below, as in speedscope. Search filters rows by name, file or package.

#### Source panel

The source panel is where most bottlenecks get confirmed, so it is always visible.

- **Gutter.** A horizontal bar per line, length = self time on that line (from V8's line ticks), with the value on hover.
- **Call sites.** Lines that call other functions show an inline chip with the time spent in the callee from that line; clicking the chip selects the callee and keeps a back entry.
- **Header.** Function totals and a mini sparkline of when it ran across the track.
- **Integrity.** If the file hash differs from the one recorded, a banner says the file changed since profiling and offers the embedded copy when present.
- **Fallback.** No source map: generated code, prettified, with original names where the map has them.

#### Track timeline

The overview band doubles as a flame-chart lane for those who prefer it: expanding a track shows its stacks over time, Chrome-style, with plumbing merged and dependencies dimmed. Each task block is labelled with its entry ("GET /orders", "timer 250 ms", "microtasks"), and tasks over 50 ms carry a warning-colored corner tick, the browser's long-task threshold reused for Node.

### Encoding rules

| Channel | Meaning | Rule |
| --- | --- | --- |
| Width or length | Time | Always time or share of time; the unit is labelled on every view |
| Hue | Origin: your code, dependency, framework, Node internals, native, GC | Six-color palette checked for color-blind safety, shown as a legend on every view |
| Lightness | Emphasis | Non-user frames dimmed to 45% opacity, never hidden |
| Single-hue gradient | Self time, when chosen in the color menu | Darker = more |
| Red, amber | Finding severity only | Never used for categories or for "slow" by itself |
| Hatching | Below measurement precision | Bars under two sampling intervals |
| "\~" prefix, "est." | Sampled estimate | Dropped when instrumented data backs the number |

Labels show `name · file:line` when they fit, then `name`, then nothing; truncation happens in the middle of long names so both ends stay readable. Numbers use ms below 10 s and s above, always with share of track beside them.

### Linking and navigation

- **One selection model:** a function, a call node, a span, a task, or a time range. Every view highlights the current selection and its hover.
- **Cross-view jumps:** "Show in waterfall", "Show in flame graph", "Show callers" on every context menu, plus double-click to open source.
- **History:** back and forward (Alt+Left, Alt+Right) across selections, view switches and transforms.
- **Transform breadcrumbs:** each transform is a removable chip in the header; clicking a chip rewinds to that point.
- **Keyboard:** `1`-`4` views, `/` search, `f` focus, `m` merge, `c` collapse package, `i` invert, `p` critical path, `?` shortcut sheet.
- **Shareable state:** the URL hash holds view, selection, range and transforms, so a reload or a pasted link restores the exact screen.

### Finding issues

Findings are rule-based, deterministic and linked to evidence; each is one sentence with a number and a **Show me** button that sets the selection and opens the view that proves it.

| Finding | Trigger (default) | Show me opens |
| --- | --- | --- |
| Event loop blocked | Any task over 50 ms; summary of count and worst | Waterfall on the longest task, critical path on |
| Synchronous I/O on a hot path | `fs.*Sync`, `child_process.*Sync`, `zlib.*Sync`, `crypto.*Sync` inside a request or timer task | Waterfall at the call, source at the line |
| Hot function | A user function above 10% self time | Source panel on its hottest line |
| Hot dependency | A package above 20% total time | Call graph, package expanded |
| GC pressure | GC above 10% of wall time, or a pause above 50 ms | Track timeline with GC markers |
| Async overhead | Plumbing frames above 15% of samples in a task kind | Flame graph with plumbing unmerged |
| Heavy serialization | `JSON.parse` or `JSON.stringify` above 5% total | Functions table filtered to callers |
| Late module loading | `require` or `import()` after startup inside request tasks | Waterfall at the load |
| Event-loop lag | p99 loop delay above 100 ms | Track timeline, delay lane |

Thresholds live in a config file and are shown inside each finding, so users can tell why something was flagged. The engine flags; it never hides data that did not trigger a rule.

### Defaults and progressive disclosure

- Open on the findings strip with the top finding selected; if there are none, open the flame graph.
- Default transforms: collapse dependencies, merge plumbing, drop idle. Each is visible and removable.
- First-run hints: one dismissible tip per view, explaining its axis.
- Small profiles: under 200 samples, a banner warns the numbers are statistically noisy and suggests a longer run or `--interval 100`.
- Huge profiles: level-of-detail rendering (Canvas 2D for bars, aggregated when sub-pixel), so a 10-minute capture stays interactive.

### Accessibility and theming

Light and dark themes from the OS, every color paired with a second cue (pattern, label or position), full keyboard operation, and screen-reader text for the findings list and details drawer.

## UI shell and CLI

The standalone shell is a local HTTP server plus the user's own Edge or Chrome in app mode, which gives a native-feeling window with no Electron and no native binaries (R4, R5).

**Launch sequence**

1. Target exits (or Ctrl+C). The CLI runs the engine passes and writes the session.
2. The CLI starts a server on `127.0.0.1` with a random port and a random 32-byte token in the URL; requests without the token are refused.
3. It looks for Edge, then Chrome, then Chromium, and launches `--app=<url> --user-data-dir=<tmp profile>` so the window has no tabs or address bar and does not touch the user's browsing profile.
4. No Chromium browser found: open the URL in the default browser. Headless or SSH: print the URL and wait; `--no-open` forces this.
5. The server serves the UI bundle, the model (binary, streamed), and source files on request, restricted to paths inside the recorded project root.
6. Closing the window ends the CLI after a 10-second grace period, so a reload does not kill it.

**Commands**

| Command | Purpose |
| --- | --- |
| `trailmap [flags] -- <cmd...>` | Profile a command, then open the UI |
| `trailmap open <file.tmap>` | Reopen a saved session |
| `trailmap diff <a.tmap> <b.tmap>` | Open two sessions in differential mode |
| `trailmap import <file>` | Open a `.cpuprofile` or DevTools trace JSON |
| `trailmap summary <file.tmap> [--json]` | Print findings in the terminal, no UI |

**Flags**

| Flag | Default | Effect |
| --- | --- | --- |
| `--interval <µs>` | 1000 | Sampling interval |
| `--async` | off in M1 | Record async causality |
| `--duration <s>` | none | Stop profiling after N seconds, keep the app running |
| `--start-on <SIGUSR2>` | none | Start profiling on a signal instead of at launch |
| `--out <file>` | `./.trailmap/<time>.tmap` | Session path |
| `--embed-sources` | off | Copy source files and maps into the session |
| `--no-open` | off | Print the URL instead of opening a window |
| `--include <glob>` / `--exclude <glob>` | all Node processes | Choose which processes in the tree to profile |

**UI stack**

- TypeScript, Vite build, one static bundle shipped inside the npm package.
- Preact for chrome and panels; views drawn on Canvas 2D for bars and SVG for the call graph; the engine query layer in a Web Worker.
- The bundle talks to the host only through a `HostAdapter` (load model, read source, open file in editor, save settings), so the VS Code webview and a future DevTools panel replace only the adapter.

## Performance and scale

The reference workload is a 60-second run sampled at 1 ms: about 60,000 samples per track. All targets are measured on a mid-range laptop and checked in CI from M2.

| Stage | Target |
| --- | --- |
| Target slowdown, default mode | under 5% |
| Engine passes after exit, 60 s profile | under 1.5 s |
| UI first paint after the window opens | under 500 ms |
| Transform or filter applied | under 50 ms |
| Pan or zoom frame | 60 fps (16 ms) |
| Largest supported capture | 10 minutes at 1 ms, 8 tracks |
| Session size, 60 s profile, no embedded sources | under 5 MB |

How: columnar typed arrays instead of object graphs, one shared string table, the model streamed to the UI as a binary buffer, Canvas rendering with level of detail, and the call-graph layout off the main thread.

## Testing

Every engine pass is tested against fixtures with known answers, and the whole tool is tested end to end against small programs with deliberate bottlenecks.

- **Engine unit tests (Vitest).** Golden `.cpuprofile` and event fixtures in, model snapshots out, per pass. Source-map tests cover inline maps, `webpack://` paths, missing maps and TypeScript via `tsx`.
- **Bottleneck zoo.** A set of tiny Node apps, each with one planted problem: a sync `fs.readFileSync` in a request handler, a hot regex, an RxJS chain, a GC-heavy loop, a worker pool imbalance, a late `require`. Each must produce its finding, and only that one.
- **End to end.** Spawn `trailmap -- node zoo/<app>.js` on Linux, macOS and Windows in CI; assert the session, the findings, and that Ctrl+C on a server flushes and shuts down cleanly.
- **Wrapper matrix.** `npm run`, `npx`, `tsx`, `ts-node`, `nodemon`, a child process tree, worker threads: each must register the expected tracks.
- **Overhead benchmarks.** A CPU-bound and a promise-heavy benchmark run with and without the tool; the overhead budget fails the build when exceeded by more than 2 points.
- **UI tests (Playwright).** Open zoo sessions, apply transforms, switch views, check linked selection and URL-hash restore; screenshot tests for each view in light and dark.
- **Dogfooding.** Profile Trailmap's own engine with Trailmap from M2 onward.

## Milestones

Version 1.0 is the Node tool with all five views, findings and sessions. Browser support and exact instrumentation move to v2, and each milestone ends in something usable on a real project.

&#91;embedded content: roadmap: 4 milestones to v1.0, then v1.x and v2\]

The v1 cut line: M4 ships when the bottleneck zoo passes on all three operating systems and the call graph stays readable when the tool profiles itself. No dates are set; each gate is a measurement, not a calendar day.

## Risks and open questions

The biggest technical risk is async causality: the API that provides it is discouraged by Node and costly on promise-heavy code, and the logical-flow features depend on it.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| `async_hooks` overhead too high, or the API removed | Waterfall loses logical flow | Opt-in in M1; ring buffer with no allocation; event shape decoupled from the API; fall back to stack-only flow |
| Sampling too coarse for readable waterfalls | Short calls vanish or merge | Honest precision labels; `--interval 100`; instrumentation in v2 |
| Async plumbing patterns vary by library and version | Unfolded noise in views | Curated pattern list with tests per library; user pattern file; "unfold" always one click away |
| Source maps missing or wrong in real projects | Wrong names and lines | Warning badges, prettified fallback, per-file "map missing" in the details drawer |
| `NODE_OPTIONS` stripped by a wrapper or container | Target runs unprofiled | Detect zero registered processes and say so; document `--require` manual mode |
| No Chromium browser installed | App-mode window unavailable | Default browser or printed URL, same UI |
| Inspector session conflicts with a debugger already attached | Profile missing | Detect `--inspect` in flags and warn; sessions coexist in recent Node, to verify |

**Open questions**

- Final name. "Trailmap" is a working name; check npm and trademark availability.
- Does the exit-handler flush work with `node:inspector/promises`, or only the callback API? Spike in M1.
- Default sampling interval: keep 1 ms, or default to 500 µs if overhead allows?
- Should findings thresholds differ for CLI tools (short runs) and servers (long runs)?
- License: MIT or Apache-2.0.

## References

Pages consulted while writing this design, as of October 2026.

- [Node.js inspector API](https://nodejs.org/api/inspector.html)
- [Node.js async\_hooks documentation](https://nodejs.org/api/async_hooks.html)
- [Node.js CLI options, `--cpu-prof-interval`](https://github.com/nodejs/node/blob/5263cc40be3ad3a0b27605e77996daa6f49bb31a/doc/api/cli.md)
- [Clinic.js](https://github.com/clinicjs/node-clinic) and [its repositories](https://github.com/orgs/clinicjs/repositories)
- [Brendan Gregg, Flame Graphs](https://brendangregg.com/flamegraphs.html)
- [Brendan Gregg, The Flame Graph (ACM Queue)](https://queue.acm.org/detail.cfm?id=2927301)
- [speedscope](https://github.com/jlfwong/speedscope)
- [Firefox Profiler, filtering call trees](https://raw.githubusercontent.com/firefox-devtools/profiler/main/docs-user/guide-filtering-call-trees.md)
- [Datadog, Making profiling visualizations accessible to engineers at all levels](https://www.datadoghq.com/blog/profiling-visualizations/)
- [Chrome DevTools, improved navigation and filtering in the Performance panel](https://developer.chrome.com/blog/devtools-navigate-and-filter)
- [Chrome DevTools, AI assistance for performance](https://developer.chrome.com/docs/devtools/ai-assistance/performance)
- [Chrome DevTools MCP server](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [Perfetto UI documentation](https://flutter.googlesource.com/third_party/perfetto/+/refs/heads/master/docs/visualization/perfetto-ui.md)
- [Honeycomb, Trace Waterfall](https://docs.honeycomb.io/reference/honeycomb-ui/query/trace-waterfall)
- [pprof documentation](https://github.com/google/pprof/blob/9665fa269a30/doc/README.md)
- [VS Code, Performance profiling JavaScript](https://code.visualstudio.com/docs/nodejs/profiling)
- [Baltes et al., Navigate, Understand, Communicate: How Developers Locate Performance Bugs](https://arxiv.org/pdf/1706.10118)
- [EasyView: Bringing Performance Profiles into IDEs](https://arxiv.org/pdf/2312.16598)
- [Steve Souders, dynaTrace Ajax Edition](https://www.stevesouders.com/blog/2009/09/30/dynatrace-ajax-edition-tracing-js-performance/)
- [John Resig, Deep tracing of Internet Explorer](https://johnresig.com/blog/deep-tracing-of-internet-explorer/)
