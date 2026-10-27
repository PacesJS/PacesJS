# pacesJS

`paces` profiles a Node command (`npx @pacesjs/paces -- node app.js`) or a web page in a Chromium browser (`npx @pacesjs/paces browser <url>`) and opens a UI that shows what the JavaScript did in linked views. The browser design is `docs/browser-profiling.md`. Spec: `docs/JS Execution Profiler — Technical Design.md` (written under the old name "Trailmap"). Design boards: `docs/*.png`, source `docs/Trailmap — Node profiler.html`.

**Naming: Trailmap → paces.** Org/scope `@pacesjs`, CLI `paces`, sessions `.paces` in `./.paces/`, env `PACES_SESSION` / `PACES_SOCKET`. Never write "trailmap" in code, UI copy or new docs.

## Layout

pnpm workspace + Turborepo, TypeScript, ESM everywhere.

| Path                         | Role                                                                  | Constraints                                                      |
| ---------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/engine`            | Passes, execution model, query/transform layer                        | No Node, no DOM. `lib: ES2022`, `types: []`                      |
| `packages/format`            | `.paces` read/write (zip via fflate)                                  | No Node built-ins; takes/returns `Uint8Array`                    |
| `packages/collector-node`    | Preload scripts, socket client, flush                                 | Node built-ins only, zero deps                                   |
| `packages/collector-browser` | Default-browser detection, launch, CDP over a pipe                    | Node built-ins only; bundles `shared`, zero runtime deps         |
| `packages/shared`            | Process, PATH and display helpers used by the CLI and every collector | Node built-ins only, zero deps; no engine or format imports      |
| `packages/ui`                | React 19 + Vite view bundle, `HostAdapter`                            | Talks to the host only through `HostAdapter`                     |
| `packages/paces`             | Published CLI; bundles everything via tsup                            | Runtime deps must be pure JS; no native binaries, no postinstall |
| `zoo/`                       | Bottleneck zoo: tiny apps, one planted problem each                   | Deliberately naive code; excluded from lint                      |
| `e2e/`                       | Playwright + CLI end-to-end tests                                     |                                                                  |

Data flows one way: raw chunks (target) → finished model (CLI) → queries (UI worker). Packages depend downward only; import another package only through its public entry. Code needed by more than one package (CLI, Node, browser, future Electron) goes in `packages/shared`, never copied.

## Commands

`pnpm build` · `pnpm test` · `pnpm typecheck` · `pnpm lint` (eslint + boundary check) · `pnpm format` · `pnpm test:e2e`. One package: `pnpm --filter @pacesjs/engine test`. Before saying work is done, build, typecheck, lint and test all pass.

## Workflow: TDD, always

1. Write a failing test that states the behavior. Run it and see it fail for the right reason.
2. Write the minimum code to pass.
3. Refactor with tests green.

- Engine passes are tested against **real** fixtures (profiles captured from `zoo/` apps), never hand-written CDP JSON. Snapshot only small, stable outputs; otherwise assert specific values.
- Never weaken or delete a test to get green. If a spec target (overhead, timing) cannot be met, say so plainly and record the measurement.
- Verify risky Node/Windows behavior (preload paths, exit flush, SIGINT, workers) with a spike test before building on it.
- Report honestly: what passed, what failed, what was skipped.

## Code style (all TypeScript)

- `strict`, no `any` (use `unknown` and narrow), no non-null `!` outside tests, no `@ts-ignore` (use `@ts-expect-error` with a reason).
- `import type` for types (enforced). Named exports only; default exports only for config files. No barrel files except each package's `src/index.ts`.
- `const` by default, strict equality, no `console` outside `packages/paces`, `scripts/`, `e2e/`.
- Prefer plain functions and data over classes. Engine functions are pure: same input, same output, no hidden state; inject clocks and randomness.
- Hot paths use columnar typed arrays (`Uint32Array`, `Float64Array`), not object graphs. Do not allocate per sample.
- Errors: throw `Error` subclasses with actionable messages; never swallow. Missing data degrades with a warning, never an error (e.g. a missing source map).
- Comments explain why, not what, and are rare. No commented-out code; no TODOs without an issue reference.
- Prettier formats (single quotes, 100 cols, trailing commas). Do not hand-format.
- Files: `kebab-case.ts`; React components `PascalCase.tsx`; tests `<name>.test.ts(x)` under the package's `test/`, mirroring `src/`.

## Kinds of run

What differs between a Node command and a web page (which track is the program, what counts as first-party, which finding rules apply) lives in a `RunAdapter` (`packages/engine/src/run/`), a plain object chosen once from the capture and held in `PassContext.run`. Passes call it; they never ask "is this a browser?". A new kind of run is a new adapter, not a new `if`. Layout details that differ by kind (the waterfall's small-task limit) are a `RunProfile` table in `query/run-profile.ts`.

## Honest data rules (product behavior)

Sampled timings are estimates: prefix `~`, label precision (`±1 ms`), hatch bars under two sampling intervals. Exact data (instrumentation) drops the `~`. Red and amber mean finding severity only. Dim non-user frames to 45%, never hide them. Folded things are always expandable.

## Product lessons

- **The profiled program is first-party.** When the entry script lives in `node_modules` (e.g. `npx eslint .`), that package is the _target_: its functions are origin `User`, not `Dependency`. Otherwise collapse-dependencies folds the whole program into one node. Its plugins and libraries stay dependencies. Wrapper processes (npx, npm) are `support` tracks; the default track is the target.
- Test the tool on real third-party CLIs, not only the zoo. `paces -- npx eslint .` is the reference scenario: you must be able to name ESLint's own hot paths and the slow plugin functions from the UI and from `paces mcp`.
- Warnings are aggregated (one note per kind); never print one line per file.
- Live zoo runs vary with machine load: assert committed captures exactly (engine tests), assert only the planted finding's presence on live runs (e2e).
- **Cached models carry a column fingerprint** (`packages/engine/src/model-shape.ts`). Any added model column is picked up automatically; never ship a model change with a stale cache still loadable. UI query failures must log their stack (`console.error` in `app/hooks.ts`).
- **Verify on a real session, not only fixtures.** Fixtures analyze fresh and hide cache, scale and shape problems. Before calling UI work done, open a real `.paces` of `npx eslint .` through the built CLI (`paces open <file> --no-open`) and look at it.
- **Heartbeat silence is not a closed window.** Minimized or hidden windows have throttled timers (once a minute after a few minutes), so the host only treats a goodbye beacon (`pagehide`), the launched browser exiting, or a long stale threshold (`PACES_STALE_HEARTBEAT_MS`, default 5 min) as "closed". A host that exits behind a background window turns every later request into "Failed to fetch".
- **V8 deopt tracing (`--v8`) is opt-in because it changes the program's stdout.** V8 refuses its logging flags (`--log-deopt`) in `NODE_OPTIONS` and ignores them from a preload, so the preload sets `--trace-deopt`, `--trace-deopt-verbose` and `--redirect-code-traces-to` with `v8.setFlagsFromString`. That reaches `npx` children and workers, but V8 prints the tail of each `[marking dependent code ...]` message with a plain `PrintF`, past the redirect, to stdout. A collector test pins that; do not make tracing the default. Output is one file per process (workers share it), and a deopt is joined to a function by script and source position, not by thread. The `v8-deopt` finding names only first-party functions that are hot and repeatedly deoptimized for a reason on an explicit map; on most real runs it correctly stays silent. Separately from that finding, every function V8 deoptimized is marked in the UI (a down triangle on flame and waterfall bars, one on the source line); the engine counts per process (workers share their process's trace), leaves out the two on-stack-replacement reasons, and maps the line through the source map.
- **`paces mcp` is one generic stdio server.** The client starts it; `profile` runs a command inside the server process, so stdout is the protocol: the program's stdout is sent to stderr, it gets no stdin, and nothing else may print to our stdout. Tools run side by side (a profile must not block `ping`), `tools/list` is identical in every state, and the analysis tools read the current session on every call. A second `profile` while one runs is refused, and a client that goes away stops the running program. The model-facing text (`src/mcp-guide.ts`: the `paces://guide` resource and the connect-time `instructions`) carries the warning that `profile` runs arbitrary code; a test keeps it naming every tool, so update it with any tool change.
- **`useAsync` drops its data on error.** Previous results are kept only while the next request loads; never show them beside a new request's error.

## Browser lessons (learned against real Edge; the spike notes in the design were not enough)

- **Trace on the browser, not on a page.** A trace started on a page session dies with the page, so closing the window lost the whole run. It starts at browser level, and the browser is kept alive after its last window closes (`--keep-alive-for-test`), so the trace can still be collected (about 5 s). paces closes the browser itself afterwards.
- **A browser-level trace holds every renderer** (other tabs, extension and browser pages) and has no frame list. The capture host knows which frames it attached; the processes that run them are found from the frame ids on the trace's events, and other renderers are dropped while streaming and again in the converter.
- **Screenshots come from a screencast** (`Page.startScreencast`), not from the trace: a browser-level trace records none. Stopping it while paused is what keeps a login out of the session.
- **Read script text as scripts are parsed.** After the window closes the page sessions are gone. An inline script's text is only part of its document while V8 reports document lines, so scripts are laid out at their start line.
- **`ProfileChunk` events are emitted by the profiler's thread, `Profile` by the profiled one.** Group chunks by process and profile id; the thread comes from `Profile`. Each sample's source line becomes a per-line tick.
- **Sequence numbers join page events to the trace and restart in each document**, so they carry the document's start time.
- **The page's own code may live on another domain** (linkedin.com serves its app from licdn.com). Counting only the launched site as first-party folded the whole app into one dependency and left an empty waterfall. When one other site does most of the script work and serves far more functions than the launched site, it is inferred to be the app (`inferAppSites`, with a note); `--first-party` overrides. Test on a real large site, not only the zoo.
- **A long task the profiler barely sampled is not a blocking finding.** The first task after a resume can span the profiler restart (532 ms wall, 3 ms sampled).
- **The network comes from the trace, not a second recorder.** `ResourceSendRequest`, `ResourceReceiveResponse` and `ResourceFinish` are joined by request id (`trace/requests.ts`) into `browser.requests`, then the model's `page.requests` table. Only an allowlist of fields is read: response headers carry cookies, so the trace filter drops them and a privacy e2e plants a `Set-Cookie` and fails if it reaches a session. We do not rebuild DevTools' Network panel; we join requests to the code (`scriptCosts`, shown in the source panel and the summary). `functions.script` is the URL a function was parsed from, before source maps, which is what joins it to its request.
- **Who asked for a request is only known for `fetch` and XHR.** `ResourceSendRequest` carries a `stackTrace` (needs the `disabled-by-default-devtools.timeline.stack` category) only when script was running as the request was sent; images, stylesheets and parser-started scripts have none, so we do not guess a requester for them. The browser types `fetch()` and XHR as `Other`; `initiator.fetchType` says which, and we use it.
- **Milestones are the main page's, once.** Frames a script creates fire their own `domContentLoadedEventEnd` and `loadEventEnd` with no frame id (a hundred on LinkedIn), and the initial blank document reports ready before the page does. A milestone needs the main frame's id, and the last ready and load of each navigation count. Test on a real busy site; the zoo had neither.
- **The page script must never throw while describing an event.** Its listeners swallow errors so the page keeps working, which also hid a missing click mark for an SVG icon (`className` is an object there). Read the `class` attribute, and give every new element type a real-browser test.
- **Idle time has a cause.** `stretches` (`query/idle.ts`) says, moment by moment, whether the main thread ran a task, was idle with a request in flight, or was idle with none; the `slow-load` finding sums it and the Waiting lane draws it.
- **Judge compression by bytes, not by headers.** `encodedDataLength` against `decodedBodyLength` says whether a text file shrank. A missing `content-encoding` in a trace is not proof: a header-based count on bbc.com wrongly called six compressed scripts plain text.
- **Sites are registrable domains from the public suffix list** (`tldts`), so `bbc.co.uk` is not `co.uk`.
- **Never record what was typed.** Events are structure only; the privacy e2e types a secret into a page and fails if it appears anywhere in the unzipped session.
- Real-browser tests are skipped unless `PACES_BROWSER` points at a Chromium executable. Measure with `node scripts/bench-browser.mjs`.

## Git

Conventional commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`), small and focused, tests and implementation together. Do not commit `.paces` files, `dist/`, or screenshots outside `e2e/`.

## Windows

Development happens on Windows. Use `pathToFileURL()` for `--import`, quote paths in `NODE_OPTIONS`, use named pipes `\\.\pipe\paces-<id>` instead of Unix sockets, and never assume `SIGINT` can be sent to a child (on Windows it kills it). Scripts must run under both PowerShell and bash, so prefer Node scripts (`scripts/*.mjs`) over shell.

Per-file-type rules live in `.claude/rules/` (engine and format, UI, tests, collector and CLI, docs and config).
