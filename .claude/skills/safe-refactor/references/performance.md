# Performance catalog

A performance refactor is the one kind of change where something observable (speed, memory, bundle size) is _supposed_ to change. Everything else still may not. Measure before and after; an unmeasured "optimization" is just added complexity.

## Measure first

- Find hot paths with real evidence: profiler output, benchmark, slow test, React DevTools Profiler, Lighthouse/Web Vitals, bundle analyzer, slow-query logs. If the user mentioned a slow area, start there.
- Write a benchmark with representative data sizes (tinybench, `vitest bench`, benchmark.js, `pytest-benchmark`, `timeit`, Go `testing.B`). Save the command and the before numbers in the ledger.
- Accept a change only if the gain is clear beyond run-to-run noise (run several times; a rule of thumb is 10%+ on the measured path, or a complexity-class improvement on realistic sizes).
- Findings without a measurable hot path can still be logged as `defer` with the reason "not on a measured hot path".

## Common bottlenecks

| Bottleneck                                                                         | Fix                                                  | Behavior trap                                                                                                                                                                  |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Quadratic lookups (`array.find`/`includes`/`indexOf` inside a loop)                | Build a `Map`/`Set` index once                       | `find` returns the **first** match; a naive `new Map(items.map(...))` keeps the **last**. Duplicate keys and key equality (objects, `NaN`, `-0`) must be handled identically.  |
| Repeated work in loops (regex construction, JSON parse, date parsing, DOM queries) | Hoist out of the loop                                | Regex objects with the `g`/`y` flag carry `lastIndex` state; hoisting shares it across iterations.                                                                             |
| Sequential `await` of independent operations                                       | `Promise.all`                                        | Changes concurrency: rate limits, ordering of side effects, and error behavior (fail-fast, other promises keep running). Needs approval when the operations have side effects. |
| N+1 queries                                                                        | Batch/join/dataloader                                | Result ordering, error granularity, transaction semantics                                                                                                                      |
| Synchronous I/O on a request path                                                  | Async equivalents                                    | Ordering and error timing                                                                                                                                                      |
| Memory leaks (listeners, intervals, caches without bounds)                         | Cleanup, bounded caches                              | Fixing a leaked listener stops it firing: log as bug if anything observes it                                                                                                   |
| Whole-library imports (`import _ from 'lodash'`, moment locales)                   | Per-method imports, `lodash-es`, locale pruning      | Usually behavior-neutral; verify identical exports used                                                                                                                        |
| Unstable props/context values causing re-renders                                   | `useMemo`/`useCallback` at the source, split context | Render counts change; check nothing depends on them                                                                                                                            |
| Expensive computation in render                                                    | `useMemo` keyed correctly                            | Wrong keys = stale values (bug)                                                                                                                                                |
| Large lists rendered fully                                                         | Virtualization                                       | Removes off-screen DOM: behavior change, needs approval                                                                                                                        |
| Layout thrashing (interleaved DOM reads/writes)                                    | Batch reads then writes                              | Values read must be the same                                                                                                                                                   |
| Animating layout properties (`top`, `width`)                                       | `transform`/`opacity`                                | Can change visual result (sub-pixel, stacking context created by `transform`); verify visually                                                                                 |
| Unbounded recursion on large inputs                                                | Iteration with explicit stack                        | Error type on overflow changes                                                                                                                                                 |
| Redundant serialization/cloning                                                    | Remove when nothing mutates                          | Verify no aliasing-based mutation downstream                                                                                                                                   |

## Proving it

Record in the ledger for each performance finding: benchmark command, dataset description, before (median and spread), after, and the baseline tests that show outputs are identical. React: commit count and render duration from the Profiler for the same interaction script. Bundles: size before/after (gzip) from the project's build.
