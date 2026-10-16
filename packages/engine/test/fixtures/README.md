# Engine fixtures

Gzipped `RawCapture` JSON files produced by running the real zoo apps (`zoo/`) through the real
collector (`packages/collector-node`). Paths are redacted to `/project`. Never edit them by hand.

Regenerate one or all (builds the collector first; name apps explicitly to leave the rest alone):

```bash
pnpm fixtures hot-regex gc-heavy
pnpm fixtures
```

| Fixture            | Planted problem                                                                                                              | Expected findings                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `orders-server`    | Flagship: TypeScript bundle with source maps, ajv, two imbalanced workers. Sync `readFileSync` per request, hot `lineTotal`. | hot-function (lineTotal, crunch), event-loop-blocked, sync-io, event-loop-lag |
| `sync-io`          | `fs.readFileSync` in a request handler                                                                                       | sync-io                                                                       |
| `hot-regex`        | Backtracking regex in a request handler                                                                                      | hot-function (`looksValid`)                                                   |
| `gc-heavy`         | Allocation churn inside `structuredClone`                                                                                    | gc-pressure                                                                   |
| `late-require`     | A large module `require`d inside a request                                                                                   | late-module-loading                                                           |
| `rxjs-chain`       | A long RxJS operator chain per request                                                                                       | async-overhead                                                                |
| `worker-imbalance` | Worker pool where one worker gets most jobs                                                                                  | hot-function (`crunch`)                                                       |

Sampling on Windows lands near 1.6 ms per sample even at a 1000 microsecond setting; the engine
measures the real interval.
