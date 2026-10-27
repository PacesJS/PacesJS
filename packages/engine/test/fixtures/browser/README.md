# Browser fixtures

Gzipped JSON recorded by `scripts/gen-browser-fixtures.mjs` from the pages in `zoo/browser/pages/`,
through the real capture host (`packages/collector-browser`) driving a real Chromium. Never edit them
by hand.

Regenerate one or all (needs a Chromium: `PACES_BROWSER=<path>`, `--browser <path>`, or a Chromium
default browser):

```bash
pnpm fixtures:browser
pnpm fixtures:browser forced-layout slow-click
```

Each file holds `input` (what the capture host hands the engine: filtered trace events, segments,
marks, scripts, source text) and up to eight screenshots as base64 JPEG. Timings vary with machine
load, so tests of these captures assert the planted finding and exact structure, not exact numbers.

| Fixture             | Planted problem                                           | Finding                                 |
| ------------------- | --------------------------------------------------------- | --------------------------------------- |
| `slow-click`        | A click handler that takes about 220 ms                   | slow-interaction, main-thread-blocked   |
| `forced-layout`     | A loop that writes a style, then reads layout, 400 times  | forced-layout                           |
| `third-party`       | A heavy script served from a second origin                | third-party-cost                        |
| `worker-and-iframe` | Work on the page, in a worker and in a cross-site iframe  | three tracks; third-party-cost (iframe) |
| `layout-shift`      | A banner inserted above content after it was painted      | layout-shift                            |
| `paused-resume`     | `slow-click`, paused and resumed once: two trace segments | a paused band between the segments      |
| `big-script`        | A large script served as plain text, and the same gzipped | uncompressed-text                       |
| `slow-load`         | A hero image the server sends after 2.8 s                 | slow-load                               |
| `slow-doc`          | HTML the server takes 1.3 s to start sending              | slow-document                           |
| `late-hero`         | A script fetches the slow hero image after load           | slow-load, naming the requesting script |

Each file is budgeted at about 500 KB gzipped (a test enforces it); if a fixture outgrows that, the
capture-time filter is wrong, not the budget.
