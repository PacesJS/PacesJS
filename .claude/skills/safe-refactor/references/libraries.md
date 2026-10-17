# Hand-rolled code versus libraries and built-ins

Replacing a custom implementation with a well-maintained one removes code to maintain, but only when the replacement does **exactly** what the custom code does for every input it receives.

## Order of preference

1. **Platform built-ins** available on the project's targets. Check `browserslist`, `tsconfig` `target`/`lib`, `engines.node`, or the Python version before using newer APIs.
2. **A dependency already declared in the project** (`dependencies`/`devDependencies`, `pyproject`). Don't rely on transitive dependencies; they can disappear.
3. **A new dependency**: requires user approval (non-negotiable 6). Include in the proposal: what it replaces (lines removed), bundle/install size, maintenance activity, license, tree-shakeability, and whether it adds transitive dependencies.

## Common candidates (JS/TS)

| Hand-rolled | Built-in or common library | Equivalence pitfalls |
| --- | --- | --- |
| Deep clone via JSON or recursion | `structuredClone` | Drops functions and class prototypes, throws on functions/DOM nodes; JSON version drops `undefined` and converts Dates to strings. Each behaves differently. |
| Deep equality | `node:util.isDeepStrictEqual`, `lodash/isEqual`, `dequal` | NaN handling, `-0`, Maps/Sets, prototype checks, key order |
| Debounce/throttle | `lodash/debounce`, `lodash/throttle` | Leading/trailing edge, `maxWait`, `this` binding, return value, `cancel`/`flush` |
| UUID generation | `crypto.randomUUID()` | Format and version; secure-context requirement in browsers |
| Query strings | `URLSearchParams` | Array encoding (`a=1&a=2` vs `a[]=1`), `+` vs `%20`, ordering, empty values |
| URL joining/parsing | `new URL(path, base)` | Trailing slashes and relative resolution rules |
| Group by | `Object.groupBy` / `Map.groupBy` | Returns a null-prototype object; key coercion to string |
| Array helpers | `.at()`, `.flat()`, `.findLast()`, `.toSorted()` | `toSorted` returns a copy; hand-rolled may have mutated |
| Date formatting/arithmetic | `Intl.DateTimeFormat`, `date-fns`, `Temporal` (if available) | Time zones, DST, locale defaults, 2-digit years |
| Number/currency formatting | `Intl.NumberFormat` | Rounding mode, locale separators, negative formats |
| Relative time | `Intl.RelativeTimeFormat` | Thresholds for "yesterday" vs "1 day ago" |
| Class name joining | `clsx`/`classnames` | Handling of falsy values, arrays, objects |
| Abortable fetch/timeout | `AbortController`, `AbortSignal.timeout()` | Error type/name on abort |
| Promise utilities | `Promise.allSettled`, `Promise.any` | Result shape |
| Retry/backoff | `p-retry` and similar | Delay schedule, jitter, which errors retry |
| Event emitter | `EventTarget`, `node:events` | Listener ordering, error event semantics, `once` |
| Email/URL validation regex | `URL` constructor for URLs; keep the regex for email | Different acceptance sets: almost never an exact match |
| Path manipulation | `node:path` / `path.posix` | Windows separators |
| Object pick/omit/get | Destructuring, optional chaining, `lodash/get` | Path syntax, defaults for `null` vs `undefined` |

Python equivalents: `functools.lru_cache`/`cache`, `itertools` (`groupby` requires sorted input!), `collections.Counter`/`defaultdict`, `dataclasses`, `pathlib`, `statistics`, `datetime.fromisoformat`, `textwrap`, `shlex`.

## Procedure

1. Read the hand-rolled implementation fully and list its semantics: every branch, default, error, and edge case.
2. Read the replacement's documentation for the same list. Any difference that can be reached by real inputs means **not an exact match**.
3. Write baseline tests over the edge cases (and, for pure functions, a differential test: old implementation as oracle vs. new, over generated inputs; see baseline-testing.md).
4. Swap, run, and delete the old implementation and its own tests only once the baseline passes.

**Leave it when:** the custom code is short (under ~15 lines), clear, and the replacement would be a new dependency; the custom version is tuned for a hot path; its semantics intentionally differ from the library's; the library is heavy relative to the use (e.g. pulling in moment.js for one format call).
