# Browser profiling — technical design

Status: proposed, ready for implementation. Written 2026-10-26 after a throwaway spike on Windows 11 (Edge 155, Node 24). The spike code is not checked in; everything it established is recorded here.

Companion to the [original design](<JS Execution Profiler — Technical Design.md>), whose "Browser provisions" section reserved the shapes this document fills in. Where the two disagree, this document wins for browser work.

## Overview

`paces browser <url>` should be as simple as `paces -- node app.js`: one command, the program runs, you do your thing, you stop, and a UI opens that shows what the JavaScript did.

paces launches the user's **default browser** if it is Chromium-based (Chrome, Edge, Brave, Vivaldi, Opera, Chromium) and exits with a clear error if it is not. It drives the browser over the Chrome DevTools Protocol (CDP) through a private pipe, records a trace (CPU samples plus exact rendering, input and frame events plus screenshots), injects a small script that turns user actions into marks and shows a pause and mark overlay, and writes one `.paces` session. The engine and UI that exist today read it; both gain browser-specific lanes.

What this design adds, in one list:

- A new package, `@pacesjs/collector-browser`: default-browser detection, launch, CDP over a pipe, trace capture with filtering, the injected script.
- A trace-to-capture converter in the engine, shared by live capture and by `paces import` of DevTools traces.
- A session format minor bump: filtered timeline events, screenshots, trace segments, embedded sources.
- UI: filmstrip, page lane, render lane, interaction lane, paused bands, browser track labels.
- Findings that only a browser can have (forced layout, slow interaction, third-party cost, layout shift).
- `paces browser` on the CLI and a `profile_browser` MCP tool.

### Non-goals for the first release

- Firefox and Safari. They have no CDP; the CLI refuses them.
- Profiling a browser the user already has open without `--attach`. Chromium only honors the debugging flags at startup.
- Mobile browsers, remote devices, headless CI profiling.
- Desktop apps built on Chromium (Electron, CEF). The spike tried three; see the [appendix](#appendix-desktop-apps).
- Exact (instrumented) browser timings. Same rule as Node: sampled timings carry `~`.

## What the spike established

Everything below was measured or observed on one Windows 11 machine with Edge 155 as the default browser. Items in the second table are not verified and are open questions, not facts.

### Verified

| Question                          | Result                                                                                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find the default browser          | Works from the registry with `reg.exe`; see [Launching](#launching-the-browser). Edge showed as `MSEdgeHTM`.                                                                                                                                        |
| CDP over `--remote-debugging-pipe` | Works on Windows from Node's `spawn` with `stdio: ['ignore','ignore','ignore','pipe','pipe']`. Commands go to fd 3, replies come from fd 4, both NUL-delimited UTF-8 JSON. No WebSocket, no dependency.                                             |
| Auto-attach                       | `Target.setAutoAttach { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }` on the page session attached a cross-site iframe (separate renderer process) and a dedicated worker before their code ran. `Runtime.runIfWaitingForDebugger` resumes each. |
| CPU samples from every thread     | The trace's `ProfileChunk` events held the planted functions from the page main thread, the worker thread and the out-of-process iframe, each on its own pid and tid.                                                                              |
| Injected script and marks         | `Page.addScriptToEvaluateOnNewDocument` plus `Runtime.addBinding` delivered events from the page. `console.timeStamp('paces:…')` landed in the trace as a `TimeStamp` event. The delta between two marks was 1.45 ms in the trace and 1.40 ms by the binding's epoch clock. |
| Screenshots                       | 266 frames in about 5 s, roughly 5 KiB each (JPEG, about 500×330 px, downscaled by the browser), about 1.2 MiB (1,253 KiB) as base64 in total. A decoded frame showed the real post-click page.                                                                       |
| Source text                       | `Debugger.getScriptSource` returned the text for page and iframe scripts.                                                                                                                                                                           |
| Ending a run                      | After closing every page target the browser exited, and the pipe closed about 250 ms later. The pipe closing is a usable end-of-run signal.                                                                                                        |
| The existing path                 | `paces report`, `paces import` and the UI read the spike trace with no code changes: three tracks, correct self times, four findings. See [Gaps in the existing import](#gaps-in-the-existing-import).                                              |

### Gotchas that cost time

- **Screenshots appear only when `Tracing.start` runs on a page session.** On the browser endpoint the same categories produced zero `Screenshot` events. CPU samples from workers and out-of-process iframes were still captured through the page session.
- **`Runtime.addBinding` delivers nothing until `Runtime.enable`** has been sent on that session.
- **Do not pass an extra `about:blank` and also create a target.** The extra tab kept the browser alive after the profiled page closed. Launch with one startup tab, attach to it, configure it, then navigate.
- **Read targets after they exist.** `Target.getTargets` right after launch returned an empty list for one app. Use discovery events or auto-attach, not a single read.
- **The trace clock is monotonic.** Trace `ts` is microseconds since an arbitrary origin, not epoch time. Anchor it explicitly; see [Clock anchor](#clock-anchor).
- **Tracing flush is slow.** Collecting a 5 to 6 s trace took 2 to 7 s for a page and 11 to 21 s for large apps using `transferMode: ReportEvents`.

### Measurements

| Measurement                                                  | Value                                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Trace of a trivial page, about 5 s, before any filtering     | 28.7 MB JSON, 3.2 MB gzipped, about 107k to 119k events                     |
| Same trace after dropping browser plumbing and screenshots   | 11.2 MB JSON, 0.8 MB gzipped                                                |
| Tracing overhead on one CPU-bound loop (4 runs per setting)  | about 53 to 54 ms untraced, 57 to 62 ms traced, with or without screenshots |
| A large app trace, about 6 s (two apps)                      | 82.7 MB and 129 MB                                                          |

The overhead figure is one micro-benchmark on one machine; it is a reason to measure again, not a number to quote. Milestone 2 re-measures.

### Not verified

- Chrome's restriction on remote debugging with the default user-data directory (reported for recent Chrome; not tested because the spike always used a throwaway directory).
- Chrome and Brave. Only Edge was the default browser here.
- Screenshots when the window is minimized, occluded or on a locked screen. Expect no frames.
- Whether tracing started on one page session also records screenshots for other tabs.
- Default-browser detection on macOS and Linux (designed below, never run).
- An isolated JavaScript world for the injected script (designed below, never run).
- Whether `Tracing.start` with `transferMode: ReturnAsStream` and gzip is faster and lighter than `ReportEvents`.
- Whether excluding categories alone removes most of the bloat, or a host-side name filter is also needed.
- That `Page.addScriptToEvaluateOnNewDocument` runs under a strict Content Security Policy, and that a constructed stylesheet in `adoptedStyleSheets` is not blocked by `style-src`. The spike page had no policy.
- That `Network.loadNetworkResource` fetches source maps with the page's cookies. The spike page had no source maps.
- `Debugger.enable` and `getScriptSource` on workers. The spike read page and iframe sources only.
- `Page.navigatedWithinDocument` for single-page-app route changes.
- Discovery of tabs the user opens by hand, and of `window.open` popups.

### Gaps in the existing import

The spike's 25 MB trace went through `paces report`, `paces import` and the UI unchanged: three tracks (page main thread, iframe thread, worker thread), correct self times (`busy` about 344 ms on the page, 286 ms in the worker, 198 ms in the iframe), four findings, and a 111 KB session. The existing importer keeps only the CPU profiles, so these gaps are what this design closes:

1. Everything except CPU samples is discarded: no screenshots, render events, `RunTask` or `EventDispatch`, marks or FCP.
2. `(program)` was 49% of busy time. Style, layout and paint hide there, and the trace has exact events that explain it.
3. All tracks are `kind: 'process'` labeled `<file> · pid N tid N`; the trace has the names to call them page, iframe and worker.
4. Tasks are inferred from samples and named `other · (anonymous)`; the trace can name them (`click button "Save"`).
5. Every page script classifies as `user`, because an `http://` URL looks like first-party code. A third-party script would too, and so would builtins with no URL such as `getElementById`.
6. The injected script's own functions (`send`, `addEventListener`) appeared as the user's code.
7. The source panel says "Outside the project root … is not shown": the importer carries no script text.
8. The header says `$ paces -- import <file>` and `Ended by Exit`, and the start time comes from the file's modification time, because a trace has no wall-clock anchor.

## Requirements

| #   | Requirement                                                                                                                  | Priority |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | -------- |
| B1  | `paces browser <url>` launches the default Chromium browser with a throwaway profile and records until the user stops        | Must     |
| B2  | A non-Chromium or unknown default browser is refused before anything launches, with an actionable message                    | Must     |
| B3  | Records page, iframe (including out-of-process) and worker CPU samples on one timeline with exact render, frame, input events | Must     |
| B4  | An injected script turns user events into marks (never recording typed values) and shows an overlay with pause, mark, stop   | Must     |
| B5  | The injected script is paces' own instrumentation: folded by default, never counted as the user's code                       | Must     |
| B6  | Pausing stops the recording, including screenshots, so a login is never captured                                              | Must     |
| B7  | Capture-time filtering keeps sessions small; the filter is recorded in the session and can be turned off                     | Must     |
| B8  | A screenshot filmstrip aligned to the timeline, capped and deduplicated                                                      | Must     |
| B9  | Sources and source maps are embedded from the capture; no project root is needed to read them                                | Must     |
| B10 | The UI shows render, frame, page and interaction lanes and labels tracks as page, iframe, worker                              | Must     |
| B11 | Older readers open a browser session as CPU-only; new readers open every older session                                      | Must     |
| B12 | `paces import` of a DevTools trace uses the same converter                                                                  | Should   |
| B13 | `--attach <port>` joins a browser the user started with remote debugging                                                     | Should   |
| B14 | CPU throttling and cold cache options, recorded in the session and shown in the header                                      | Should   |
| B15 | An MCP `profile_browser` tool                                                                                                | Should   |
| B16 | macOS and Linux                                                                                                              | Should   |

## Architecture

Same three-process shape as Node: the target (the browser), the CLI that owns the engine, and a UI window that only renders. The "collector" lives in the CLI process because a browser cannot be preloaded.

```text
  user's default Chromium browser                paces CLI process                    UI window
  ┌──────────────────────────────┐  CDP pipe  ┌─────────────────────────────┐  HTTP  ┌──────────┐
  │ page · iframes · workers     │◄──────────►│ collector-browser           │───────►│ React UI │
  │  └ injected script + overlay │  fd 3 / 4  │  launch · trace · filter    │ token  │ + worker │
  │      │ Runtime binding       │            │  controller (pause/mark)    │        └──────────┘
  │      └──────────────────────►│            │ engine: trace → capture →   │
  └──────────────────────────────┘            │         model (passes)      │
                                              │ format: .paces session      │
                                              └─────────────────────────────┘
```

Data still flows one way: raw trace events (browser) → filtered capture (host) → finished model (CLI) → queries (UI worker).

### Package changes

| Package                         | Change                                                                                                                                                    | Constraints                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `packages/collector-browser`    | New. Default-browser lookup, launch, CDP pipe client, tracing and filtering, session controller, injected script and overlay (built to a string constant) | Node built-ins only, zero dependencies            |
| `packages/engine`               | `src/trace/` converter, browser branches in target, classification and tasks passes, new timeline pass, new findings, new model tables                    | No Node, no DOM; the converter takes parsed events |
| `packages/format`               | Optional manifest fields, screenshot and timeline files, `FORMAT_VERSION` 1.1.0                                                                          | No Node built-ins                                 |
| `packages/paces`                | `browser` command, hotkeys, status panel, server route for screenshots, MCP tool                                                                          | Runtime deps stay pure JS and bundled             |
| `packages/ui`                   | Filmstrip, page, render and interaction lanes, `HostAdapter` screenshot access                                                                            | Talks to the host only through `HostAdapter`      |
| `zoo/browser/`                  | Planted-problem pages, one per finding                                                                                                                    | Deliberately naive; excluded from lint            |

`import-profile.ts` keeps `.cpuprofile` handling; its trace branch moves into the engine converter so there is exactly one trace importer.

## Launching the browser

### Finding the default browser

The CLI never launches "the browser" blindly. It resolves the user's default `https` handler to an executable, decides whether it is Chromium-based, and only then launches that executable itself. Opening a URL through the OS (`start <url>`) does not work: the URL goes to a running instance that ignores debugging flags.

**Windows** (run on this machine):

```text
reg query "HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice" /v ProgId
reg query "HKCR\<ProgId>\shell\open\command" /ve
```

The second value looks like `"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --single-argument %1`. Take the quoted path. Spawn `reg.exe` with `execFile`, never through a shell. Chromium ProgIds, matched as prefixes: `ChromeHTML`, `MSEdgeHTM`, `BraveHTML`, `VivaldiHTM`, `OperaStable`, `ChromiumHTM`. Anything else (for example `FirefoxURL-…`) is refused.

**macOS** (designed, not run): read the `https` entry in the LaunchServices `LSHandlers` plist (`defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers`) for a bundle id. Chromium ids: `com.google.chrome`, `com.microsoft.edgemac`, `com.brave.Browser`, `com.vivaldi.Vivaldi`, `com.operasoftware.Opera`, `org.chromium.Chromium`, `company.thebrowser.Browser`. Resolve the bundle to its executable under `Contents/MacOS`.

**Linux** (designed, not run): `xdg-settings get default-web-browser` returns a `.desktop` file; read its `Exec=` line and match the executable name against `google-chrome*`, `chromium*`, `microsoft-edge*`, `brave*`, `vivaldi*`, `opera`.

Detection takes injected `exec` and `exists` functions so the parsing is unit-testable without a registry. After launch, `Browser.getVersion` confirms the product (`Chrome/…`, `Edg/…`); a mismatch with the allowlist is an error even if the ProgId matched.

**Overrides.** `--browser <path>` skips detection for a Chromium executable, which is also how CI and the tests choose a browser. It is the only escape hatch from "default browser".

### Errors before launch

Exit code 2, nothing launched, one actionable sentence:

```text
paces: the default browser (Firefox) is not Chromium-based. paces can profile Chrome, Edge, Brave, Vivaldi, Opera and Chromium. Install one, or pass --browser <path>.
paces: could not tell which browser is the default. Pass --browser <path> to a Chromium browser.
paces: no display found, so there is no browser window to profile. Run this on a desktop session, or use --attach with a browser started elsewhere.
```

The headless check reuses `isHeadless()` from `launch.ts`.

### Launch

```text
<exe> --remote-debugging-pipe --user-data-dir=<tmp> --no-first-run --no-default-browser-check
      --disable-sync --window-size=1440,900 about:blank
```

- One startup tab, `about:blank`. paces attaches to it, injects, enables tracing, then navigates. This avoids the race where the page runs before the script is installed and avoids a second tab.
- A fresh temporary profile per run, removed on exit with the existing `removeDetached`. The user's logins, extensions and cookies are not present. This is also the only mode that works with newer Chrome's default-directory restriction (unverified; see above). Logged-in pages need `--attach`.
- The pipe is private to the CLI process: no TCP listener exists, so no other local process can drive the browser. `--attach` uses `127.0.0.1` and says so.
- `killTree` ends the browser tree on Ctrl+C or crash. On Windows `child.kill()` only ends the root.

### CDP transport

The client is about 60 lines: write `JSON.stringify(message) + '\0'` to fd 3; read fd 4, split on NUL, parse each part. Requirements:

- Handle partial chunks and multiple messages per chunk.
- Every request has a timeout and rejects with the method name.
- A closed pipe rejects everything pending and fires the end-of-run signal.
- Windows spike test (committed in Milestone 0): spawn, `Browser.getVersion`, close, assert exit and pipe end. If pipe inheritance fails on some Windows setups, the fallback is `--remote-debugging-port=<random>` on `127.0.0.1` with a minimal WebSocket client over `net`; Node's global `WebSocket` is not available on Node 20, which `engines` still allows.

### Targets

Browser-level `Target.setDiscoverTargets` plus attach on `targetCreated`, then on each page session `Target.setAutoAttach` with `flatten: true` and `waitForDebuggerOnStart: true`. For each attached target:

1. `Runtime.enable`, then `Runtime.addBinding` for the bridge.
2. `Page.enable` and `Page.addScriptToEvaluateOnNewDocument` for pages and iframes.
3. `Debugger.enable` for pages, iframes and workers, to capture script sources.
4. `Runtime.runIfWaitingForDebugger`.

Each page, iframe, worker and extension target becomes a track (kinds below). New tabs and `window.open` popups become tracks automatically. Whether browser-level auto-attach alone discovers them is to verify; discovery plus explicit attach is the fallback.

### End of run

Any of these ends the run, in this order of precedence: the user presses `s` in the terminal or Stop in the overlay; Ctrl+C (same five-second flush rule as Node); `--duration` elapses; every page target closes or the pipe ends (the user closed the window). The result records `endedBy`: `stop`, `sigint`, `duration`, or the new `window-closed`.

## Capture

### Tracing

Tracing starts on the **first page's session**, not the browser endpoint (screenshots require it; see gotchas). The category set, from the spike:

```text
-*
devtools.timeline
v8.execute
disabled-by-default-devtools.timeline
disabled-by-default-devtools.timeline.frame
blink.user_timing
latencyInfo
disabled-by-default-v8.cpu_profiler
disabled-by-default-devtools.screenshot      (omitted with --no-screenshots)
```

The spike also enabled `toplevel` and `blink.console`; `toplevel` alone produced about 57k of 119k events in one run, almost all of them plumbing, so it is dropped by default. `blink.console` is needed for `console.timeStamp`. Whether each remaining category is needed is verified by test in Milestone 2 against the planted-problem fixtures.

### Filtering the bloat

Unfiltered traces are the biggest practical obstacle: 28.7 MB for five seconds of a trivial page, and 83 MB and 129 MB for six seconds of two large apps. Most of that is the browser's own scheduling and IPC bookkeeping, not JavaScript. Where the bytes were, in the page trace:

| Event name (category)                                        | Size in the page trace | Keep? |
| ------------------------------------------------------------ | ---------------------- | ----- |
| `Edge_RunTask`                                               | 5.6 MB                 | No    |
| `ThreadControllerImpl::RunTask` (`toplevel`)                 | 5.0 MB                 | No    |
| `RunTask` (`disabled-by-default-devtools.timeline`)          | 3.1 MB                 | Yes   |
| `IOHandler::OnIOCompleted`                                   | 2.6 MB                 | No    |
| `Receive mojo message`                                       | 1.7 MB                 | No    |
| `SimpleWatcher::OnHandleReady`                               | 1.3 MB                 | No    |
| `cc::TaskGraphWorkQueue::ScheduleTasks`                      | 0.5 MB                 | No    |
| `BlinkScheduler_PerformMicrotaskCheckpoint`                  | 0.4 MB                 | No    |

The per-name sizes and category counts come from one run of the page and the 28.7 MB and 11.2 MB totals from another run of the same page, so they differ by a few percent. Category share by event count in the first run: `toplevel` 56.8k, `disabled-by-default-devtools.timeline` 23.2k, `base,toplevel` 13.1k, `cc,benchmark,…timeline.frame` 10.4k, `toplevel,mojom` 5.4k, `devtools.timeline` 5.1k. Dropping the five largest plumbing names and the screenshots took the page trace to 11.2 MB (0.8 MB gzipped).

Category membership was checked on the spike trace, which was recorded with `toplevel` enabled, so excluding `toplevel` does not remove anything the design reads:

| Event                                                                   | Category in the trace                           |
| ----------------------------------------------------------------------- | ----------------------------------------------- |
| `RunTask`, `TracingStartedInBrowser`, `FrameCommittedInBrowser`         | `disabled-by-default-devtools.timeline`         |
| `EventDispatch`, `Layout`, `Paint`, `FunctionCall`, `TimeStamp`         | `devtools.timeline`                             |
| `UpdateLayoutTree`                                                      | `blink,devtools.timeline`                       |
| `DrawFrame`, `BeginMainThreadFrame`                                     | `disabled-by-default-devtools.timeline.frame`   |
| `firstContentfulPaint`                                                  | `loading,rail,devtools.timeline`                |
| `Profile`, `ProfileChunk`                                               | `disabled-by-default-v8.cpu_profiler`           |
| `Screenshot`                                                            | `disabled-by-default-devtools.screenshot`       |
| `ThreadControllerImpl::RunTask`, `Edge_RunTask`                         | `toplevel` (the only events seen in that category) |

The other events in the converter's list, such as `LayoutShift`, `Layerize` and `ParseHTML`, did not occur in the spike trace, so their categories are not confirmed; Milestone 2 checks each against the fixtures before the category list is final.

**Filter layers**, applied by the host while the trace streams in, so a 129 MB trace never sits in memory:

1. **Categories.** Do not request `toplevel`, `base`, `mojom`; use `excludedCategories` for them as well. Hypothesis: this removes most of the bulk. Milestone 2 measures it and records the number.
2. **Process rule.** Trace metadata names each process (`Browser`, `GPU Process`, `Renderer`, `Extension Renderer`, utility processes). Keep every event from renderers that host an attached target and from extension renderers; from other processes keep only an allowlist (`Screenshot` and the frame events the timeline pass uses).
3. **Name denylist.** A versioned list (`TRACE_NOISE_NAMES`) seeded with the plumbing names in the table above. A test asserts every name in the list was seen and counted in the fixture trace, so a stale list is noticed.
4. **Argument slimming.** After layers 1 to 3, measure bytes per event name again. Strip bulky arguments that no pass reads (for example stack traces on layout events that are not forced layouts). Not specified further until measured.
5. **Privacy scrub.** Remove query strings and fragments from `url` fields in kept events. Page and script URLs are kept to origin and path unless `--keep-query` is passed.
6. **Screenshots.** Deduplicate identical consecutive frames by hash, store each frame once as a JPEG file (not inside JSON), cap at 600 frames and 64 MiB per session (keep every Nth when over, always keep the first and last), and stop capturing while paused.
7. **Transport.** Evaluate `Tracing.start` with `transferMode: 'ReturnAsStream'` and gzip, read with `IO.read`, and filter per chunk. Keep `ReportEvents` as the fallback. Choose by measurement.

**Fidelity.** The engine rule is that raw data is never rewritten after capture. The filtered trace _is_ the raw capture: it is what the host chose to write, once, at capture time. The manifest records exactly what that choice was:

```json
{
  "traceFilter": {
    "version": 1,
    "excludedCategories": ["toplevel", "base", "mojom"],
    "droppedByName": { "Edge_RunTask": 3120, "ThreadControllerImpl::RunTask": 4210 },
    "keptEvents": 41890,
    "droppedEvents": 77012
  }
}
```

`--full-trace` bypasses layers 1 to 4 and keeps everything. It exists for debugging paces itself and prints the size it expects.

**Budgets to confirm in Milestone 2 (targets, not promises):** a 10 s interactive session of a typical development page stays under about 10 MB of filtered timeline JSON (under 2 MB zipped) before screenshots; screenshots stay under the 64 MiB cap. Record the real numbers in the session header and in `docs`. If a budget cannot be met, say so and record the measurement.

**Collection time.** Flush takes seconds to tens of seconds. The status panel shows `collecting trace… 41%` (bytes read against bytes reported), and the UI never opens until the session is written.

### Segments and pausing

Pause really stops tracing. A login screen is exactly when screenshots and event labels must not be recorded, and tracing categories cannot change mid-run.

- **Pause:** `Tracing.end`, collect and filter that segment, then keep the browser and page running unprofiled.
- **Resume:** `Tracing.start` again; a new segment begins.
- **Start paused:** `--paused` navigates and shows the overlay, but starts no tracing until the first resume.

Each segment has `{ startUs, endUs }` on the trace clock. The engine merges CPU profiles per thread across segments (each `Tracing.start` creates new `Profile` ids) and keeps the gaps; the UI shows paused bands. Pausing has latency (the flush); the overlay shows `Pausing…` until the segment is on disk.

Fallback if the flush latency proves unacceptable in Milestone 3: a soft pause that keeps tracing and records only a paused range, with screenshots and event labels disabled by script. It must not be the default, because the trace itself would still contain the login page's activity.

### Clock anchor

Trace `ts` is monotonic microseconds; marks and `CaptureMeta` use epoch milliseconds. Engine timestamps are absolute microseconds, so the host anchors the clocks once per segment:

1. Right after `Tracing.start` resolves, the host calls `__paces__.sync()` in the top frame.
2. The script runs `console.timeStamp('paces:sync:<n>')` and returns `performance.timeOrigin + performance.now()`.
3. The converter finds the trace `TimeStamp` with that message, takes its `ts`, and computes `offsetUs = epochMs * 1000 - ts`.

The spike's two-mark check agreed to 0.05 ms, so sub-millisecond accuracy is expected; the error is recorded in `meta.precision`. Traces imported from DevTools carry no anchor and fall back to the file's modification time, as today.

### Sources and source maps

- `Debugger.enable` on every page, iframe and worker; collect `Debugger.scriptParsed` (script id, URL, `sourceMapURL`, hash).
- Fetch text with `Debugger.getScriptSource`. Fetch source maps with `Network.loadNetworkResource` (so cookies and CORS behave like the page); `data:` maps are decoded by the engine as today.
- Embed sources and maps by content hash in `sources/<hash>`, as `--embed-sources` does for Node. Always on for browser sessions, with a per-source cap of 5 MiB and a per-session cap of 32 MiB. Anything skipped becomes one aggregated warning.
- Source paths are virtual: `<host>/<path>` for network scripts and the source map's own paths (`webpack://…`) after mapping. Reads use the existing embedded-source query (`query/embedded-source.ts`), never the project-root guard, which only governs disk reads.

### Throttling and cache

`--throttle <n>x` (`Emulation.setCPUThrottlingRate`), `--cache cold` (`Network.setCacheDisabled`, fresh profile already means cold on first load). Both are recorded in the manifest and shown in the header, because they change every number.

## The injected script

One small script, built from TypeScript to a JavaScript string constant by the `collector-browser` build, installed with `Page.addScriptToEvaluateOnNewDocument` on every page and iframe so it survives navigations and loads before page code. The browser applies it regardless of the page's Content Security Policy.

### Marked as our own instrumentation

- The built source ends with `//# sourceURL=paces://instrumentation/inject.js`. Without it, the spike showed the script's functions with no URL, listed as the user's code.
- `isPacesInstrumentation` (`engine/src/util/paths.ts`) matches `paces://instrumentation/` URLs in addition to the Node preload paths. The existing consequences apply: classification gives origin `node`, the plumbing pass marks it, the target pass never picks it as an entry script, and the UI folds it. Folded things stay expandable.
- A test fails the build if the built script lacks the `sourceURL` line or if a function from it appears as `user` in any browser fixture.

### Isolation (to verify)

Install the script in an isolated world (`Page.addScriptToEvaluateOnNewDocument` with `worldName: 'paces'`, and `Runtime.addBinding` with `executionContextName`), so page code cannot see, overwrite or break it, and our globals do not leak into the page. The script still shares the DOM. If bindings or `console.timeStamp` do not reach the trace from an isolated world, fall back to the main world with one non-enumerable global (`__paces__`) and the binding name `__pacesBridge`. Decide in Milestone 3 by test.

### What it records

Passive listeners, capture phase, installed on `window`, never calling `preventDefault` or `stopPropagation`, every handler wrapped in `try`/`catch`. It never patches page APIs (no `history` or `fetch` wrapping): SPA route changes come from the CDP event `Page.navigatedWithinDocument` and navigations from `Page.frameNavigated`, on the host.

| Kind        | Trigger                                  | What is kept                                                                 |
| ----------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| `click`     | `click`, `dblclick`                      | Target description (below)                                                   |
| `submit`    | `submit`                                 | Form description                                                             |
| `change`    | `change` on select, checkbox, radio      | Field description, never the value                                           |
| `key`       | `keydown` for non-printable keys        | Key class only: `Enter`, `Escape`, `Tab`, `Arrow`, or `Shortcut` for modifier combos |
| `typing`    | `input` bursts, coalesced after 500 ms   | One entry per burst: field description, duration, keystroke count; no text  |
| `scroll`    | First `scroll` after 1 s of quiet        | `scroll`, no position                                                        |
| `navigate`  | Host, from CDP                           | Origin and path of the new URL, query and fragment dropped                   |
| `visibility`| `visibilitychange`                       | `hidden` or `visible`                                                        |

Pointer movement, `pointerdown`, `mousemove` and `keydown` for printable keys are never recorded. Limits: at most 20 events per second and 5,000 per run; beyond that, a single `…N more` entry.

### Target descriptions and privacy

A description is built from structure and names, never from values:

- Tag, `id`, `data-testid`, `role`, and for inputs `type` and `name`: `input[type=email]#signup-email`.
- The accessible name only for `button`, `a`, `summary`, `label` and elements with `role` button, link, tab or menuitem: `aria-label`, then `title`, then text content, truncated to 40 characters.
- Never `value`, `placeholder`, `textContent` of inputs, textareas or `contenteditable` elements, or anything inside a `type=password` field.
- A path of at most three ancestors when there is no id: `form#login > button.primary`. Total at most 60 characters.

`--no-event-text` drops the text-derived names and keeps only structure. A committed end-to-end test types a recognizable secret into a field and fails if it appears anywhere in the session file, including screenshots metadata, labels and trace arguments.

### How events leave the page

Each recorded event gets a sequence number and goes two ways: `console.timeStamp('paces:<seq>')` places it exactly on the trace clock, and `__pacesBridge(JSON)` carries `{ seq, at, kind, label, frame }` to the host. The converter joins them by `seq`. If the trace has no `TimeStamp` for a number (for example the segment was paused), the event falls back to `at` converted through the clock anchor. Iframes install the same script without the overlay and report their frame id.

### The overlay

A small control pill in the top frame only. It exists so a person can log in or navigate to the right page before profiling, and can mark moments by hand.

**States**

| State                | Look                                                           | Meaning                                                       |
| -------------------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| Recording, collapsed | A small dot, 12 px, with an accessible name `paces: recording` | Normal; stays out of the way and out of screenshots as far as possible |
| Recording, expanded  | Pill: status, elapsed time, **Pause**, **Mark**, **Stop**       | On hover, focus or `Alt+Shift+P`                              |
| Pausing              | Pill with `Pausing…`, buttons disabled                          | Waiting for the trace flush                                   |
| Paused               | Pill, always expanded: `Paused, not recording`, **Resume**, **Mark**, **Stop** | Nothing is recorded; screenshots are off                      |
| Ready                | Same as paused with `Ready to record`, **Start**               | `--paused` run before the first start                         |
| Stopping             | `Saving…`                                                       | Final flush                                                   |

**Controls**

- **Mark** opens a one-line input; Enter adds a mark with that label (blank gives `Mark n`), Escape cancels. A manual mark is recorded while recording and while paused (it is a note, not trace data) and placed at its moment on the next timeline.
- **Pause** and **Resume** toggle recording as described under [Segments](#segments-and-pausing).
- **Stop** ends the run exactly like pressing `s` in the terminal.
- Shortcuts, bound in the capture phase and only while the overlay is shown: `Alt+Shift+M` mark, `Alt+Shift+P` pause or resume. The terminal gets the same actions: `m` mark (exists), `s` stop (exists), `p` pause or resume (new). All of them call the same controller methods; `ProfileControls` gains `pause()` and `resume()`.
- The overlay can be dragged to any corner so it never covers the thing being profiled. Its position is held by the host and re-sent after each navigation. It never writes to the page's `localStorage`, cookies or `sessionStorage`.

**Construction**

- A host element with a **closed shadow root**, `all: initial` inside, fixed position, the highest `z-index`. Page styles do not reach it and its styles do not reach the page.
- DOM is built with `createElement` and `textContent`, never `innerHTML` (Trusted Types pages reject it). Styles go in a constructed stylesheet attached through `adoptedStyleSheets`, which a `style-src` policy does not block.
- Static: no animation or transition, so it adds no continuous paints to the render lane and no differences between filmstrip frames. It honors `prefers-reduced-motion` and `prefers-color-scheme`.
- Accessible: `role="toolbar"`, real buttons, visible focus, labels read by screen readers. Colors come from a neutral blue and grey set, not red or amber, which the product reserves for finding severity.
- Events from inside the overlay are not recorded as user events (checked with `event.composedPath()`).
- It appears in screenshots and its small layout and paint work appears in the render lane. Both are accepted; `--no-overlay` removes it and leaves terminal hotkeys only.

### Host and script protocol

Script to host, through the binding, JSON per call:

```text
{ "t": "hello", "frame": "top" | "sub", "url": "https://…" }
{ "t": "event", "seq": 17, "at": 1792281035179.4, "kind": "click", "label": "button \"Save\"" }
{ "t": "control", "action": "pause" | "resume" | "start" | "mark" | "stop", "label": "after login" }
```

Host to script, through `Runtime.callFunctionOn` in the script's context:

```text
__paces__.state({ phase: "recording" | "pausing" | "paused" | "ready" | "stopping",
                  elapsedMs, marks, position })
__paces__.sync()          → returns epoch milliseconds, emits the sync TimeStamp
```

After each navigation the script says `hello`, and the host answers with `state`, so the overlay survives login redirects.

### Failure modes

- Binding calls that never arrive: the host logs one aggregated warning, the run continues without automatic events.
- Page navigates away while a `control` call is in flight: the host applies the action once; repeated calls are idempotent.
- Pages that block everything (for example `about:blank` error pages, `chrome://` pages): no script, no overlay; terminal hotkeys still work.

## Session format

`FORMAT_VERSION` moves to `1.1.0`. Every addition is optional, so a 1.0 reader opens a browser session as a CPU-only session (tracks and samples, no timeline, no screenshots) and a 1.1 reader opens every 1.0 session unchanged. `engineVersion` also bumps so cached models are rebuilt; the model column fingerprint catches new columns on its own.

```text
session.paces
  manifest.json              as today, plus the browser fields below
  raw/<track>.cpuprofile     V8 profile per thread (merged across segments)
  raw/<track>.timeline       NDJSON of filtered timeline events for the track (new)
  raw/<track>.scripts        script ids, URLs, source map URLs, hashes
  raw/screenshots.json       index: [{ id, tsUs, hash }] (new)
  raw/screenshots/<id>.jpg   one JPEG per distinct frame, stored not deflated (new)
  sources/<hash>             embedded source text and source maps
  model/<engine-ver>.bin     cached model, disposable
```

Manifest additions:

```json
{
  "kind": "browser",
  "browser": { "product": "Edg/155.0.4283.62", "url": "http://localhost:3000/", "headless": false },
  "clock": { "offsetUs": 1792281035179469, "errorUs": 50 },
  "segments": [{ "startUs": 1200, "endUs": 6400000 }],
  "traceFilter": { "version": 1 },
  "screenshots": { "count": 266, "bytes": 1280000, "deduplicated": 41, "cap": 600 },
  "throttle": { "cpu": 4 },
  "endedBy": "window-closed"
}
```

`marks` entries gain an optional `kind` (`manual` by default, otherwise one of the event kinds above), so older readers still show manual marks and ignore the rest. Track entries gain optional `url`, `frameId` and `origin`, and `TrackKind` gains `extension`.

## Engine

### One trace converter

`packages/engine/src/trace/` holds a pure converter from parsed trace events to a capture fragment. Live capture and `paces import` both call it, so a DevTools-exported trace gets the same tracks, tasks and lanes (without screenshots or the clock anchor). It:

1. Groups events by `pid:tid`, reads `process_name` and `thread_name` metadata, and the frame events (`TracingStartedInBrowser`, `FrameCommittedInBrowser`) to give each thread a role, an origin and a label.
2. Merges `Profile` and `ProfileChunk` events per thread across segments, with gaps.
3. Extracts the timeline events the passes read: `RunTask`, `EventDispatch`, `FunctionCall`, `EvaluateScript`, `UpdateLayoutTree`, `Layout`, `PrePaint`, `Paint`, `Layerize`, `Commit`, `DrawFrame`, `BeginMainThreadFrame`, `FireAnimationFrame`, `TimerFire`, `ParseHTML`, `ResourceSendRequest`, `firstContentfulPaint`, `largestContentfulPaint::Candidate`, `LayoutShift`, `TimeStamp`.
4. Converts times through the clock anchor when present.

New raw types in `raw.ts`: `TimelineEvent` (name, start, duration, thread, small args), `ScreenshotRef`, optional `RawCapture.browser` and `meta.segments`, `RawTrack.timeline`.

### Passes

The ten ordered passes stay in order. Browser behavior is added inside them, plus one new pass.

| Pass                 | Browser change                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ingest               | Per-thread profiles merged across segments; gaps kept as `paused` spans                                                                                                                                             |
| Source maps          | URLs resolve through embedded maps; `webpack://` and network URLs normalize to virtual paths                                                                                                                        |
| Target               | Browser branch: the primary track is the top page's main thread; the first party is the launched URL's origin (hosts sharing a registrable suffix by simple label match, plus `--first-party <glob>`); launcher logic is skipped |
| Classification       | See below                                                                                                                                                                                                           |
| Plumbing             | `paces://instrumentation/` frames marked; browser plumbing (promise jobs, event dispatch wrappers) uses the existing curated list                                                                                   |
| Spans                | Unchanged; precision stays plus or minus one sampling interval                                                                                                                                                      |
| Tasks                | Exact tasks from `RunTask`, labeled by the dominant inner event: `click button "Save"`, `timer`, `animation frame`, `parse HTML`, `script`, `rendering`. New `TaskKind` values, additive                              |
| Timeline (new)       | Builds frame, render, input, vitals and screenshot tables from the converted events (below)                                                                                                                         |
| Findings             | New browser rules (below)                                                                                                                                                                                           |

### Classification in the browser

Today every non-`node_modules` URL is `user`, which was right for the spike page by accident and wrong for third-party scripts and for built-ins. Browser rules:

| Frame                                                              | Origin       | Notes                                                                |
| ------------------------------------------------------------------ | ------------ | -------------------------------------------------------------------- |
| `paces://instrumentation/…`                                        | `node`       | Marked plumbing, folded                                              |
| No URL and no script (`getElementById`, `addEventListener`, native) | `native`     | These showed as the user's code in the spike                         |
| `(program)`, `(idle)`, `(garbage collector)`                       | as today     | `(program)` is split by render events, below                         |
| Same origin or `--first-party` match as the launched URL           | `user`       | `app://`, `file://`, `http(s)://` alike                              |
| Source-mapped `node_modules/` path                                 | `dependency` | Package name from the path, as today                                 |
| Any other origin                                                   | `dependency` | `pkg` holds the host, for example `cdn.example.com`; no new enum     |
| `chrome-extension://…`                                             | `dependency` | `pkg` is `extension:<id>`; the track kind is `extension`             |
| `node:electron/…`                                                  | `node`       | Desktop apps only                                                    |

The existing origin enum is unchanged, so the legend, filters and "collapse dependencies" transform work as they do now. A dedicated third-party view can come from `pkg` later.

### Splitting `(program)`

In the spike, `(program)` was 49% of busy time: in a sampled profile, style, layout and paint hide there. The timeline pass finds `(program)` samples that fall inside an exact `UpdateLayoutTree`, `Layout`, `Paint`, `Layerize` or `Commit` event on the same thread and re-attributes them to synthetic native frames (`(style recalc)`, `(layout)`, `(paint)`, `(composite)`). This is model construction, not rewriting the raw capture, and it is a design decision to confirm in Milestone 1 against the planted forced-layout fixture. If it proves misleading, the alternative is render lanes only, with `(program)` left alone.

### Model additions

Columnar typed arrays, interned strings, row ids as indexes:

- `track.kind` gains `extension`; labels like `Page · localhost:3000`, `iframe · cdn.example.com`, `Worker · worker.js`, `Extension · <id>`.
- `frames`: `start`, `end`, `dropped` (`Float64Array`, `Uint8Array`).
- `render`: `start`, `duration`, `phase` (style, layout, paint, composite, parse, script), `forced` flag.
- `inputs`: `start`, `end`, `kind`, `label` (string id), `taskId`.
- `vitals`: `time`, `kind` (navigation, DCL, load, FCP, LCP, shift), `value`.
- `screenshots`: `time`, `id` only. The bytes stay out of the model and reach the UI through `HostAdapter`.
- `meta.segments`, `meta.throttle`, `meta.clock`.

Timings from trace events are exact and carry no `~`. Only CPU-sampled JavaScript does. The header precision chip stays `Sampled`, and the legend gains an `Exact` entry for timeline lanes.

### Findings

Pure rule functions, thresholds in config and echoed in each finding, one sentence, one number, evidence rows, a `showMe` target. Initial set:

| Kind                  | Fires when                                                                                              | Example sentence                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `main-thread-blocked` | A main-thread task longer than 50 ms; ranked by the longest and the total                               | `One task blocked the page for 1.2 s, starting at 3.4 s.`                         |
| `slow-interaction`    | An input event whose next paint is more than 200 ms later                                               | `Clicking button "Save" took 480 ms to show a result.`                            |
| `forced-layout`       | Layout or style recalc run inside a JavaScript task, more than 10 times or more than 20 ms in one task  | `read of offsetWidth in thrash() forced layout 60 times (~35 ms).`                |
| `third-party-cost`    | Origins other than the first party use more than 10% of main-thread busy time                            | `Scripts from cdn.example.com used 28% of the main thread (~410 ms).`            |
| `layout-shift`        | Cumulative layout shift is 0.1 or more                                                                  | `The page shifted 0.32 after 2.1 s.`                                              |

The existing hot-function and hot-path findings keep working on every track. The Node-only ones (`event-loop-blocked`, `sync-io`, `module-loading`) do not run on browser sessions.

## UI

### Host access to screenshots

The model holds only screenshot times and ids. `HostAdapter` gains:

```ts
readScreenshot(id: number): Promise<Uint8Array>;   // JPEG bytes
```

implemented by the HTTP host (`/api/screenshot/<id>`, token required, served from the session zip) and by the in-memory adapter used in tests and the dev server. The UI creates object URLs lazily as the filmstrip scrolls into view and revokes them off-screen.

### Layout

For a browser session, the Overview region stacks, top to bottom:

1. **Filmstrip.** Thumbnails positioned by time. Spans with no frame (hidden window, paused) are hatched and labeled, never blank.
2. **Page lane.** Navigation, DOMContentLoaded, load, FCP and LCP markers; layout-shift ticks; long-task ticks (50 ms, reusing the existing corner tick); paused bands hatched.
3. **Track lanes** as today, one per page, iframe, worker and extension, with task blocks named by the new task labels.
4. **Render lane** for the selected page track: stacked style, layout, paint and composite blocks, frame boundaries, dropped frames.
5. **Interaction lane:** automatic events aggregated (a typing burst is one block), clustered when zoomed out, with counts.

Manual marks stay in the existing `MarkFlags`, which is built for a handful of flags; automatic events never go there. Dragging across any lane sets the shared range for every view, as now. Hovering a time in any lane shows a crosshair across all lanes and a popover with the nearest filmstrip frame. Clicking a frame sets the selection to that moment. Selecting a task, finding or function highlights it in every lane.

### Header, tracks and copy

- Command chip: `$ paces browser http://localhost:3000`.
- `Ended by`: `Stopped`, `Window closed`, `Duration`, `Ctrl+C`.
- Chips when present: `4× CPU throttle`, `Cold cache`, `Contains screenshots` (with a tooltip pointing at `--no-screenshots`), `Paused 2×` (segments).
- Track labels are `Page · localhost:3000`, not `trace.json · pid 1 tid 2`.

### Honest-data and design rules

- Exact lanes (render, frames, inputs, vitals) show no `~`; sampled CPU keeps `~` and the precision chip. The legend says which is which.
- Red and amber stay reserved for finding severity. The render phases use existing palette tokens that are neither (checked in both themes against `theme/palette.ts` and `tokens.css`); no new hard-coded colors.
- Non-user frames (third-party origins, extensions, instrumentation) are dimmed to 45% and folded, never hidden.
- The source panel reads from embedded sources for browser sessions. "Open in editor" is shown only when a source map path resolves to a file under `--root <dir>` (default the current directory); otherwise it is hidden with a short reason. The project-root guard does not apply to embedded reads.
- Filmstrip frames are buttons with accessible names (`Frame at 1.24 s`), arrow-key navigation, a visible focus ring, no animation under `prefers-reduced-motion`.
- UI query failures log their stack through `app/hooks.ts`, as the product lessons require, and `useAsync` still drops stale data on error.

## CLI

```text
paces browser <url> [flags]
paces browser --attach <port> [flags]
```

| Flag                    | Meaning                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `--browser <path>`      | Use this Chromium executable instead of the default browser                                          |
| `--attach <port>`       | Join a browser started with `--remote-debugging-port`; loopback only; use for logged-in profiles    |
| `--paused`              | Start with recording paused; the overlay shows **Start**                                             |
| `--duration <s>`        | Stop after this many seconds                                                                         |
| `--no-screenshots`      | Do not capture the filmstrip                                                                         |
| `--no-overlay`          | No overlay; hotkeys in the terminal only                                                             |
| `--no-event-marks`      | Do not record automatic user events                                                                  |
| `--no-event-text`       | Record event structure but no text-derived names                                                     |
| `--keep-query`          | Keep query strings and fragments in stored URLs                                                      |
| `--full-trace`          | Skip capture-time filtering; sessions get large                                                      |
| `--first-party <glob>`  | Extra origins to treat as first-party (repeatable)                                                   |
| `--root <dir>`          | Where source-mapped paths are resolved for "Open in editor"                                          |
| `--throttle <n>x`       | CPU throttling                                                                                       |
| `--cache cold`          | Disable the cache for the run                                                                        |
| `--interval`, `--out`, `--no-open`, `--no-keys`, `--no-panel` | As for Node runs                                                     |

Exit codes: 0 when a session was written, 1 on failure, 2 when nothing could launch (unsupported or unknown default browser, no display). The browser has no exit code to mirror.

Terminal hotkeys while running: `m` mark, `p` pause or resume, `s` stop. The status panel shows the phase, elapsed time, marks and event counts, and during the final flush `collecting trace… 41%`.

`--attach` installs the same script (once for the current page with `Runtime.evaluate`, then for every later navigation), traces, and leaves the browser running when the profile ends. It is the way to profile a logged-in profile.

Security and privacy, additions to the existing rules: the launched browser is driven over a private pipe (no listener); `--attach` binds nothing but connects to `127.0.0.1` and says so; each run uses a fresh profile that is deleted afterwards; nothing leaves the machine; stored URLs drop query strings and fragments by default; screenshots can contain anything on the page, so the CLI prints one line when saving a session that contains them, the README and the header chip say so, and pausing stops capture.

## MCP

A new tool, `profile_browser`, beside `profile`, with `{ url, until: "load" | "idle" | seconds, throttle?, firstParty? }`. It opens a visible browser window, so it is refused when headless, and its description says that a page's own JavaScript runs on the user's machine. Analysis tools read the current session as they do now, so a browser session works with `summary`, `findings`, `hot_paths`, `top_functions` and the rest unchanged. `tools/list` stays identical in every state and a second profile while one runs is refused.

`src/mcp-guide.ts` (the `paces://guide` resource and connect-time `instructions`) must name the new tool and carry the arbitrary-code warning for browsers; the existing test that requires every tool to be named is updated first. Scripted interactions (click, fill, wait) are deliberately not part of this tool: model-supplied input values are a privacy and safety question, and they come later if at all.

## Testing

TDD, as everywhere in this repo: each module starts with a failing test that states the behavior. No hand-written CDP JSON in engine tests; fixtures are traces captured from `zoo/` apps.

### Fixtures

- `zoo/browser/` pages, each with one planted problem and a tiny zero-dependency static server: `forced-layout` (a loop that writes then reads layout), `slow-click` (a 200 ms click handler), `third-party` (a script served from a second local origin), `worker-and-iframe` (a worker and a cross-site iframe, the spike's page), `layout-shift` (late-inserted content).
- `scripts/gen-browser-fixtures.mjs` launches a real Chromium through the collector (path from `PACES_BROWSER` or `--browser`), runs each page, and writes filtered traces and at most eight small screenshots per page to `packages/engine/test/fixtures/browser/`. A test enforces a size budget per fixture (about 500 KB each, gzipped); if a fixture exceeds it, the filter is wrong, not the budget.
- Fixtures are committed captures, so engine tests assert exact values on them. Live runs assert only that the planted finding is present, because timings vary with machine load.

### Unit tests by module

| Package             | Test file (under `test/`, mirroring `src/`)                | States                                                                                                               |
| ------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `collector-browser` | `default-browser.test.ts`                                  | Parses the registry output above; accepts every Chromium ProgId; refuses `FirefoxURL-…`; bundle ids and `.desktop` `Exec=` lines |
|                     | `cdp-pipe.test.ts`                                         | Framing across partial chunks, several messages per chunk, timeouts, pending requests rejected on close              |
|                     | `trace-filter.test.ts`                                     | Streaming filter keeps renderers, drops listed names, counts what it dropped, scrubs query strings                   |
|                     | `session-controller.test.ts`                               | Pause, resume, start paused and stop against a fake CDP: segments, screenshot stop, marks while paused, idempotent controls |
|                     | `inject/labels.test.ts`                                    | Descriptions never contain values; password fields; `contenteditable`; truncation; `--no-event-text`                 |
|                     | `inject/coalesce.test.ts`                                  | Typing bursts, scroll quiet period, rate limits                                                                      |
|                     | `inject/overlay-state.test.ts`                             | State reducer for the overlay phases and shortcuts                                                                   |
|                     | `inject/build.test.ts`                                     | Built script ends with the `paces://instrumentation/` `sourceURL`                                                    |
| `engine`            | `trace/trace-to-capture.test.ts`                           | Tracks, labels and roles from real fixtures; segments merged with gaps                                               |
|                     | `trace/clock-sync.test.ts`                                 | Offset from the sync `TimeStamp`; fallback without one                                                               |
|                     | `util/paths.test.ts`                                       | `isPacesInstrumentation` matches `paces://instrumentation/` and still matches the Node preload                      |
|                     | `passes/classification-browser.test.ts`                    | Table above: first party, third party, extension, empty URL, instrumentation                                         |
|                     | `passes/tasks-browser.test.ts`                             | Task labels from `RunTask` and `EventDispatch`                                                                       |
|                     | `passes/timeline.test.ts`                                  | Frames, render phases, inputs, vitals; `(program)` split on the forced-layout fixture                                |
|                     | `passes/findings-browser.test.ts`                          | One finding per planted problem, thresholds echoed, no Node-only findings                                            |
| `format`            | `manifest-browser.test.ts`                                 | 1.1 manifest round trip; a 1.0 reader fixture opens it CPU-only; 1.1 reads 1.0; major mismatch refused               |
|                     | `screenshots.test.ts`                                      | Deduplication, caps, first and last kept                                                                             |
| `paces`             | `browser-command.test.ts`                                  | Flag parsing; each error message and exit code; `--attach`; hotkeys                                                  |
|                     | `mcp-guide.test.ts`                                        | Guide names `profile_browser` and the browser warning                                                                |
| `ui`                | `Filmstrip`, `PageLane`, `RenderLane`, `InteractionLane`   | Rendering from a memory adapter; hatched gaps; hover and click linking; keyboard operation                           |
|                     | `host/memory.test.ts`                                      | `readScreenshot`                                                                                                     |

### Browser-in-the-loop tests

Skipped unless `PACES_BROWSER` points at a Chromium executable, run in CI with a pinned one.

- **Windows transport (Milestone 0, written first):** spawn with the pipe stdio, `Browser.getVersion`, open and close a page, assert the browser exits and the pipe ends; kill a stuck browser tree.
- **Launch and capture:** `paces browser <zoo url> --browser <path> --duration 5 --no-open`; assert a session with the planted finding, no `user`-origin function from `paces://instrumentation/`, the track labels above, and the size budget.
- **Overlay and marks:** start the browser with `--remote-debugging-port` through Playwright, run `paces browser --attach <port>`, and drive the overlay with Playwright: pause, check no screenshots or events are recorded, resume, add a mark, stop.
- **Privacy:** type a recognizable secret into a field, run the full flow, and assert the secret appears nowhere in the unzipped session.
- **UI screenshot tests** for a browser session fixture in light and dark, under `e2e/` as the rules require.

### Before saying any milestone is done

`pnpm build`, `typecheck`, `lint` (including the boundary check, which is extended for the new package) and `test` pass. For UI work, also open a real session produced by the built CLI (`paces open <file> --no-open`) and look at it, as the product lessons require.

## Milestones

Each ends in something usable. Tests come first inside every milestone.

| #   | Milestone                    | Scope                                                                                                                                                                                      | Done when                                                                                                                                              |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M0  | Windows transport tests      | Default-browser parsing, pipe framing, spawn, exit and kill-tree tests; `collector-browser` skeleton and boundary rule                                                                    | The committed Windows test launches the default or `PACES_BROWSER` browser and closes it cleanly                                                       |
| M1  | Trace import                 | Engine `trace/` converter, browser target, classification and tasks passes, track labels, timeline pass, fixtures from `zoo/browser/`, `paces import` uses it                              | `paces import trace.json` of a DevTools trace shows page, iframe and worker tracks, named tasks and no third-party code as `user`                       |
| M2  | Capture host                 | `paces browser <url>`: launch, auto-attach, tracing on the page session, streaming filter, sources, screenshots, segments, session format 1.1, clock anchor                                | A recorded run opens in the UI with the filmstrip data in the file; size budgets measured and recorded; collection progress shown                      |
| M3  | Injected script and overlay  | Built script with instrumentation `sourceURL`, event marks, privacy rules, overlay, pause and resume, hotkeys, `--paused`, `--attach`; decide isolated world versus main world            | The privacy end-to-end test and the overlay test pass; the script never shows as `user`                                                                |
| M4  | UI                           | `HostAdapter` screenshots, filmstrip, page, render and interaction lanes, paused bands, header chips, source panel from embedded sources                                                   | A real session is inspected in the UI in both themes; screenshot tests committed                                                                       |
| M5  | Findings and MCP             | Browser findings, `profile_browser`, guide update                                                                                                                                           | Each planted problem produces its finding; the MCP guide test passes                                                                                   |
| M6  | Hardening                    | macOS and Linux detection and launch, Chrome and Brave runs, default-profile restriction check, throttling and cache options, README and `CLAUDE.md` updates                              | The not-verified list above is empty or each item is documented as a known limit                                                                       |

M1 and M4 can proceed in parallel once the M1 fixtures exist; M2 depends on M1's converter.

## Risks and open questions

| Risk or question                                                              | Plan                                                                                                                                    |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Tracing overhead beyond the one micro-benchmark                               | Re-measure in M2 on the planted pages; report the number in the header and the docs; if the spec target cannot be met, say so          |
| Capture-time filtering is not enough and traces stay huge                     | Argument slimming and process rules (layers 2 and 4); `--duration`; the budgets above are targets and the real measurement is recorded |
| Pause latency from the trace flush                                            | Show `Pausing…`; soft-pause fallback described above                                                                                    |
| Pipe inheritance fails on some Windows setups                                 | Port fallback with a minimal WebSocket client                                                                                           |
| Newer Chrome refuses debugging on the default user-data directory             | Throwaway profile by default; `--attach` against a directory the user chooses; check in M6                                              |
| Screenshots only cover the page whose session started tracing                 | Verify with several tabs in M2; if so, document it and show no frames for other tabs                                                    |
| The isolated world does not deliver bindings or `console.timeStamp`           | Main-world fallback with one non-enumerable global                                                                                      |
| First-party detection by simple host matching misjudges some sites            | `--first-party` override; no public-suffix list is bundled                                                                              |
| Production bundles without source maps give unreadable names                  | Group by script in the UI; the existing "missing source map" warning; aggregate, never one per file                                    |
| Pages that do not like automation (bot checks, strict sites)                  | The browser is a normal one with a normal user agent; nothing is spoofed; document that some sites may behave differently             |
| Some sites need extensions or a logged-in profile                             | `--attach` with the user's own debugging-enabled browser                                                                                |
| Who ends a run in `--attach` mode                                             | Same triggers; the browser stays open                                                                                                   |
| Do the "to verify" items in the spike list change the design                  | Each is a task in the milestone named in the table above                                                                                |

## Appendix: desktop apps

Out of scope for this design, recorded because the spike tried it. Chromium-based desktop apps can be driven with the same launch, attach and trace code when they allow it; they are a different promise from a browser, and refusal is a normal answer.

| App                     | Runtime                                  | Result with a remote debugging flag                                                                       |
| ----------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Claude Desktop (MSIX)   | Electron                                 | Starts without flags and with a harmless flag; **exits with code 1 immediately** when given a debugging flag |
| Spotify (MSIX)          | CEF (Chrome 151)                         | Accepted; startup trace of 82.7 MB for 6 s; function names minified, no source maps                        |
| Codex (MSIX, `ChatGPT.exe`) | Electron-based (`node:electron/…` frames, `app://` pages), Chrome 155 | Accepted; 129 MB for 6 s across seven renderer threads                                 |

Packaged apps are launched through their execution alias when one exists (for Claude `claude-desktop.exe`, for Spotify `Spotify.exe`), or by the exe path inside the package folder when none does (Codex). Running processes of the same app must be closed first, because a second launch hands off to the first and the flag is lost.

Policy if this is ever built (`paces app <exe>`): when an app exits at once on the debugging flag, say so and stop. paces does not patch app bundles, flip Electron fuses, inject code through environment variables or otherwise defeat a refusal. For an Electron app that allows it, the main process (Node) would come in through the Node collector and the renderers through the browser collector, joined in one session.

## Documentation follow-ups

When the work lands, and not before:

- `CLAUDE.md`: add `packages/collector-browser` to the layout table; extend the product lessons with the browser rules above (first party is the launched origin, pause stops tracing, never record values).
- `.claude/rules/collector-and-cli.md`: add the browser collector rules (private pipe, fresh profile, privacy scrub).
- `README.md`: `paces browser` usage, the screenshot privacy note, the Chromium-only limit.

## References

- Chrome DevTools Protocol: [Tracing](https://chromedevtools.github.io/devtools-protocol/tot/Tracing/), [Target](https://chromedevtools.github.io/devtools-protocol/tot/Target/), [Page.addScriptToEvaluateOnNewDocument](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-addScriptToEvaluateOnNewDocument), [Runtime.addBinding](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-addBinding), [Debugger](https://chromedevtools.github.io/devtools-protocol/tot/Debugger/), [Emulation.setCPUThrottlingRate](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setCPUThrottlingRate)
- [Chrome DevTools, improved navigation and filtering in the Performance panel](https://developer.chrome.com/blog/devtools-navigate-and-filter)
- [Chrome DevTools MCP server](https://github.com/ChromeDevTools/chrome-devtools-mcp)
