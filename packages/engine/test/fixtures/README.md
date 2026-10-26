# Engine fixtures

Gzipped `RawCapture` JSON files produced by running the real zoo apps (`zoo/`) through the real
collector (`packages/collector-node`). Paths are redacted to `/project`. Never edit them by hand.

Regenerate one or all (builds the collector first; name apps explicitly to leave the rest alone):

```bash
pnpm fixtures hot-regex gc-heavy
pnpm fixtures
```

| Fixture              | Planted problem                                                                                                                                                                                 | Expected findings                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orders-server`      | Flagship: TypeScript bundle with source maps, ajv, two imbalanced workers. Sync `readFileSync` per request, hot `lineTotal`.                                                                    | hot-function (lineTotal, crunch), event-loop-blocked, sync-io, event-loop-lag                                                                                                           |
| `sync-io`            | `fs.readFileSync` in a request handler                                                                                                                                                          | sync-io                                                                                                                                                                                 |
| `hot-regex`          | Backtracking regex in a request handler                                                                                                                                                         | hot-function (`looksValid`)                                                                                                                                                             |
| `gc-heavy`           | Allocation churn inside `structuredClone`                                                                                                                                                       | gc-pressure                                                                                                                                                                             |
| `late-require`       | A large module `require`d inside a request                                                                                                                                                      | late-module-loading                                                                                                                                                                     |
| `rxjs-chain`         | A long RxJS operator chain per request                                                                                                                                                          | async-overhead                                                                                                                                                                          |
| `worker-imbalance`   | Worker pool where one worker gets most jobs                                                                                                                                                     | hot-function (`crunch`)                                                                                                                                                                 |
| `eslint-cli`         | A CLI that is itself an npm package: `node eslint/bin/eslint.js` (typescript-eslint, react-hooks) on the zoo sources and `packages/engine/src/passes`; the zoo app only waits                   | hot-dependency (typescript-eslint, plugin), hot-path; no event-loop findings; 2 tracks (zoo app supporting)                                                                             |
| `async-chain`        | `main()` awaits `run()` awaits `readAndVerify()` per file, CPU `verify()` after each await, a `reporter()` step last                                                                            | hot-function (`checksum`), hot-path; stitched logical tree; 1 track                                                                                                                     |
| `eslint-cli-wrapped` | The same through a launcher process, like `npx eslint`                                                                                                                                          | as `eslint-cli`; 3 tracks (2 supporting)                                                                                                                                                |
| `deopt-loop`         | A hot `price(item)` that receives objects of five different shapes across requests, so V8 optimizes it and throws the code away again. Captured with `PACES_V8_TRACE=1` (the generator sets it) | hot-function (`total`, `price`), v8-deopt (`price`, "wrong map"): the V8 finding needs a hot function. The OSR deopts of `total` are ignored by design. Not in the all-fixtures goldens |

The generator copies `argv` and `cwd` from each `<track>.info` into the track info (`readCaptureDir` does not yet),
which is what lets the engine find the entry script; older fixtures have none and exercise the fallback to the
first loaded script. The eslint apps keep dependency source maps (~1 MB gzipped each).

Sampling on Windows lands near 1.6 ms per sample even at a 1000 microsecond setting; the engine
measures the real interval.
