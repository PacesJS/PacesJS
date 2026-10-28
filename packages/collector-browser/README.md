# @pacesjs/collector-browser

Records a web page in a Chromium browser: default-browser detection, launch over a private pipe (or joining a browser the user started), tracing, screenshots, script sources, and the script and overlay injected into the page. Node built-ins only; `@pacesjs/shared` is bundled in.

It produces a `BrowserRecording` (filtered trace events, segments, marks, screenshots, scripts, sources). Turning that into a capture is the engine's job (`recordingToCapture`), and `paces` ties the two together.

## How a run works

1. Launch the browser with `--remote-debugging-pipe` and a fresh temporary profile, or connect to `127.0.0.1:<port>` (`--attach`).
2. Attach to the page, install the injected script and the debugger on it and on everything it auto-attaches (iframes, workers).
3. Start tracing **on the browser**, then navigate. Screenshots come from `Page.startScreencast`.
4. A pause ends the trace segment (and stops the screencast); a resume starts a new one. The gap is kept.
5. On stop or when the last page closes, end the trace, read it back (about 5 s), close the browser.

## Things learned against a real browser

Each of these cost a failing run to find, and each has a test (`PACES_BROWSER=<chromium> pnpm --filter @pacesjs/collector-browser test`):

- A trace started on a **page session** is lost when the page closes. It starts on the browser instead, and `--keep-alive-for-test` keeps the browser (and the pipe) alive after its last window closes. Closing the window is the normal way to end a run, so this matters.
- A browser-level trace holds **every renderer** and has no frame list. The processes that run the recorded frames are found from the frame ids on trace events; the rest are dropped while streaming (`ownFrames`).
- A browser-level trace records **no screenshots**. The screencast supplies them, and is stopped while paused.
- **Source text must be read when a script is parsed**: after the window closes the sessions are gone. An inline script's text is only part of its document, so it is laid out at its start line.
- `Runtime.addBinding` delivers nothing until `Runtime.enable`; an overlay appended before `<body>` exists becomes the document root. Both are tested in a real page.
- `ProfileChunk` events come from the profiler's thread; the `Profile` event names the profiled one.
- A **covered window stops painting**. Windows' occlusion tracking and background throttling froze a window behind others, so a recording lost click-to-paint latency, the largest paint and its screenshots. The launch flags (`--disable-features=CalculateNativeWinOcclusion`, `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`, `--disable-background-timer-throttling`) keep it painting; a test pins them.
- Stopping the browser kills its **whole process tree**: on POSIX the descendants are listed with `ps` before the root is killed, since killing only the root left renderers running.

## What it costs

Measured with `node scripts/bench-browser.mjs` on one Windows 11 machine, Edge 155, a CPU-bound loop run ten times per page load, median of four loads. One micro-benchmark; use it to see the order of magnitude, not as a figure to quote.

| Run                               | Median time of the loop  |
| --------------------------------- | ------------------------ |
| No tracing                        | 3.9 ms                   |
| Recording (overlay, screencast)   | 4.2 ms (about 8% slower) |
| Recording with `--no-screenshots` | 4.2 ms (about 8% slower) |

Session size, five seconds of recording a zoo page (the filtered trace; screenshots are separate JPEGs, stored once each, at most 600 frames and 64 MiB):

| Page                | Events kept | JSON    | Gzipped |
| ------------------- | ----------- | ------- | ------- |
| `slow-click`        | 662         | 181 KiB | 25 KiB  |
| `forced-layout`     | 1,390       | 396 KiB | 35 KiB  |
| `third-party`       | 870         | 235 KiB | 30 KiB  |
| `worker-and-iframe` | 1,064       | 367 KiB | 54 KiB  |
| `layout-shift`      | 673         | 179 KiB | 25 KiB  |

The capture-time filter drops 12,000 to 27,000 events per page (the browser's scheduling, interrupt markers, loader bookkeeping, other renderers). Before it, a trace of the same pages is several times larger. These are small pages: a large application is much bigger (the design's spike saw 83 to 129 MB unfiltered for six seconds of two large desktop apps), and that has not been re-measured with the filter. If a session is too big, `--duration` and `--no-screenshots` help.

## Known limits

- Developed on Windows and run there with Edge and Chrome. The maintainer has also run it on macOS. On Linux (Ubuntu 24.04 under WSL2, Chrome 156) it works, but the browser stalled 6 to 19 seconds on its first navigation, with or without paces, so four real-browser timing tests are unreliable on that machine. Default-browser detection on Linux is unit-tested against sample output.
- Brave, Vivaldi, Opera and Chromium share the protocol but have not been run. Chrome may refuse remote debugging on its default profile directory; paces always uses a fresh one.
- Chromium only. Firefox would need WebDriver BiDi and a converter from Gecko profiles; Safari on the desktop has no remote profiling interface a third-party tool can use. Neither is built.
- The injected script runs in the page's own JavaScript world, with one non-enumerable global (`__paces__`) and a binding named `__pacesBridge`. An isolated world was not tried. A page that deletes or shadows those can break the overlay and the marks (the profile still records).
- A strict Content Security Policy was not tested against the overlay's styles (a constructed stylesheet in `adoptedStyleSheets`, which `style-src` should not block).
- Tabs the user opens by hand are attached when the browser reports them; popups from `window.open` were not tested.
- Source maps are fetched with `Network.loadNetworkResource`; the test pages have none, so only the plumbing is tested, with a fake CDP.
- A joined browser (`--attach`) has its CPU throttle and cache setting put back at the end; that restoration is not tested.
