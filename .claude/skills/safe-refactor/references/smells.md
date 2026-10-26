# General code smells catalog

Each entry: **Signals** (how to spot it), **Fix** (the refactoring), **Leave it when** (legitimate reasons not to act), **Behavior traps** (ways the "obvious" fix silently changes behavior). The thresholds are defaults; when the project's lint config sets its own, use those.

## Contents

1. Dead code
2. Impure functions where pure ones are possible
3. Duplicated code
4. God functions and classes
5. Long parameter lists
6. Speculative generality
7. Comments
8. "Best practice" rewrites that change behavior
9. Other smells (quick table)

---

## 1. Dead code

**Signals:** unused exports, files, functions, variables, parameters, CSS classes, and dependencies; unreachable branches (after `return`/`throw`, `if (false)`, conditions contradicted by types); feature flags fixed on or off; commented-out code; tests-only exports.

**Proving it's dead.** Static "no references" isn't enough. Before deleting, search the whole repo, including non-code files (JSON, YAML, HTML, Markdown, CI configs, `package.json` scripts), for the symbol name **as a string**. Then check each of these:

- Dynamic imports and requires built from strings: `import(\`./locales/${lang}\`)`, `require(name)`
- Framework conventions that load files by location or name: Next.js/Remix/SvelteKit routes, `pages/`, `app/`, Storybook `*.stories.*`, test setup files, `jest.config` and `vite.config` references, Babel/webpack plugins, migrations, CLI command auto-discovery
- Dependency injection containers, decorators, reflection, ORM entity registration
- Public package surface: `package.json` `main`/`exports`/`types`/`bin`. If this repo publishes a library, exported symbols are API even when nothing inside the repo uses them.
- Side-effect-only imports (`import './polyfills'`) and module-level registration code
- CSS classes assembled at runtime (`` `btn-${variant}` ``), referenced from a CMS, HTML templates, or tests
- Remote-controlled flags: a flag that's always `false` in code may be flipped by a remote config service

**Fix:** delete. Remove now-unused imports and dependencies in the same finding. For remote flags or public exports, ask (non-negotiable 6).

**Behavior traps:** removing a "dead" import that has side effects; removing a parameter from a function that callers pass positionally (shifts every later argument); removing an unused dependency that another tool loads by name (Babel presets, ESLint plugins, PostCSS plugins).

## 2. Impure functions where pure ones are possible

**Signals:** computation mixed with I/O (fetch, DB, filesystem, DOM, logging) in one function; reads of `Date.now()`, `Math.random()`, `process.env`, globals, or singletons in the middle of logic; mutation of arguments; logic that's hard to test without heavy mocking.

**Fix:** functional core, imperative shell. Extract the decision-making into a pure function taking plain inputs and returning plain outputs, and keep a thin wrapper that does I/O and calls it. Pass time, randomness, and configuration in as parameters (with the old source as the default at the shell).

**Leave it when:** the function is a one-line I/O wrapper; the extraction would split logic that only makes sense together; the project's architecture deliberately keeps it there (e.g. active-record models).

**Behavior traps:**

- **Argument mutation that callers rely on.** If a function mutates its input and also returns it, some callers may use the mutated object and ignore the return value. Before switching to "return a new value", check every call site for aliasing. If any rely on the mutation, keep it or update those call sites in the same finding.
- **Evaluation order.** Extracting a pure part must not reorder side effects that remain (e.g. a log line that used to come before a thrown error).
- **Laziness.** Hoisting a computation out of a branch makes it run even when the branch isn't taken, which matters if it can throw or is expensive.

## 3. Duplicated code

**Kinds:** exact copies; renamed copies (same structure, different identifiers); structural (same shape with different literals); semantic (different code, same job).

**Signals:** jscpd hits; the same bug fixed in several places in git history; parallel files (`UserCard`/`AdminCard`) that drift; helpers redefined per module (`formatDate` in five files).

**Fix:** extract a function, module, hook, or component. Parameterize by **data**, not by boolean flags. If the extracted function needs `if (isAdmin)` branches to reproduce each copy, the copies weren't really the same, and a flag-driven abstraction is worse than duplication.

**Gate — rule of three plus same reason to change:** consolidate when there are three or more copies, or two copies that must always change together (both encode the same business rule). Two copies that look alike by coincidence and serve different owners stay separate.

**Leave it when:** duplication in tests improves readability; copies live in packages that version independently; the duplicated code is generated.

**Behavior traps:** the copies differ in a subtle detail (a `<` vs `<=`, a default, error message text). Diff the copies line by line before merging. If they differ, either the abstraction takes that difference as a parameter, or one copy has a bug, which is logged and preserved, not silently unified.

## 4. God functions and classes

**Signals:** functions over ~60 logical lines, classes over ~300; several levels of abstraction in one body (HTTP parsing next to business rules next to SQL); sections separated by comment banners; names with "and", `handle`, `process`, `manage`, `doStuff`; deep nesting (more than 4 levels); many local variables live across the whole body; cyclomatic complexity over ~15.

**Fix:** extract function per section (the comment banner often becomes the name); compose method (top-level reads as a list of steps); guard clauses for nesting; replace a repeated conditional with a lookup table or polymorphism; split a class by responsibility, grouping methods by which fields they touch.

**Leave it when:** it's a long but flat and readable dispatch (a reducer over many action types, a parser's state table); splitting would scatter one cohesive algorithm across files and force readers to jump around.

**Behavior traps:** early returns and `finally` blocks interact with extraction (a `return` inside an extracted helper no longer exits the outer function); `this` binding changes when methods become free functions; exceptions thrown mid-section previously skipped the remaining sections and still must.

## 5. Long parameter lists

**Signals:** more than 4 parameters; boolean parameters (`render(true, false, true)`); the same group of parameters travelling together through several functions (data clump); callers passing `undefined`/`null` placeholders to reach later arguments.

**Fix:** introduce a parameter object or options object; introduce a value type for clumps (`DateRange`, `Money`); split a function that takes flags into separate functions; let the callee derive values it can compute from others.

**Leave it when:** the function is a thin, conventional wrapper (e.g. mirrors a platform API); it's a hot path where object allocation measurably matters; it's exported API (ask first; consider keeping the old signature as an overload).

**Behavior traps:**

- **Default semantics.** `function f(a, b = 5)` applies the default only for `undefined`. A destructured `{ b = 5 }` behaves the same, but `opts.b || 5` also replaces `0`, `''`, and `false`, and `opts.b ?? 5` also replaces `null`. Keep the exact original semantics.
- `arguments.length` checks and rest parameters inside the function.
- Callers that spread arrays into the positional list (`f(...args)`).

## 6. Speculative generality

**Signals:** interfaces or abstract classes with one implementation and no test double; factories that only ever produce one type; strategy or plugin registries with a single entry; generic type parameters always instantiated with the same type; configuration options nobody sets; hooks, callbacks, or parameters always passed the same value or never used; "manager"/"provider" layers that only forward calls.

**Fix:** inline the abstraction, collapse the hierarchy, remove the unused option or parameter, remove the middle man.

**Leave it when:** it's a published extension point; it's a test seam that tests actually use; it's a port/adapter at a real I/O boundary and the project applies that architecture consistently; a second implementation is already in progress (check open branches/issues, or ask).

**Behavior traps:** removing an option nobody sets internally that external consumers do set (public API); removing an interface that is used for `instanceof` or runtime checks.

## 7. Comments

Comments should explain **why** or illuminate genuinely complicated code. Comments that restate **what** the code obviously does are noise and go stale.

**Remove:** comments that restate the next line (`// increment counter` above `counter++`); section banners inside a function (extract and name the section instead); commented-out code (git has it); closing-brace labels; changelog comments in file headers; JSDoc that only repeats parameter names and types already expressed in TypeScript.

**Turn into code:** a "what" comment over an unclear expression becomes an extracted, well-named variable or function.

**Keep:** why-comments and business-rule explanations; workarounds with a link to the issue; explanations of non-obvious algorithms, regexes, bit tricks, or performance choices; legal/license headers; JSDoc on public APIs that documentation is generated from; `TODO`/`FIXME` (list them in the report instead of deleting).

**Never touch these — they are behavior, not comments:** `eslint-disable*`, `@ts-ignore`, `@ts-expect-error`, `// @flow`, `/* webpackChunkName */` and other bundler magic comments, `/* istanbul ignore */`, `# type:` comments, `# noqa`, `#!` shebangs, `//go:` directives, license-preservation `/*!` comments, conditional-compilation pragmas.

**Stale comment that contradicts the code:** this is a bug signal. Log it in "Bugs found" (either the comment or the code is wrong) rather than silently deleting it.

## 8. "Best practice" rewrites that change behavior

Many textbook modernizations are **not** behavior-preserving. Only apply these when you've proven equivalence for every value that can reach the expression:

| Rewrite                                        | When it changes behavior                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `==` → `===`                                   | `null == undefined` is true; `'1' == 1` is true. Safe only when both sides are provably the same type. |
| `a && a.b` → `a?.b`                            | When `a` is `0`, `''`, `false`, or `NaN`: the old code returns `a`, the new returns `undefined`.       |
| `x \|\| d` → `x ?? d`                          | When `x` is `0`, `''`, `false`, `NaN`: old returns `d`, new returns `x`.                               |
| `var` → `let`/`const`                          | Hoisting and function scoping; closures in loops capture per-iteration bindings with `let`.            |
| `.then()` chain → `async/await`                | Synchronous throws before the first `await` now reject instead of throwing; microtask timing shifts.   |
| `for...in` → `Object.keys`                     | `for...in` includes inherited enumerable properties.                                                   |
| `arr.forEach` → `for...of`                     | Sparse arrays: `forEach` skips holes, `for...of` visits them as `undefined`.                           |
| `function` → arrow function                    | `this`, `arguments`, `new`-ability, and hoisting differ.                                               |
| `parseInt(x)` → `Number(x)`                    | `parseInt('12px')` is 12, `Number('12px')` is `NaN`.                                                   |
| Sorting helper swap                            | Stability, comparator semantics, locale-aware vs code-point comparison.                                |
| Python `dict` → dataclass, mutable default fix | Identity and shared-state semantics callers may rely on.                                               |

These are often worth doing, but each one needs a baseline test that exercises the edge values, or it's logged as a potential bug rather than "cleaned up".

## 9. Other smells (quick table)

| Smell                       | Signal                                                                      | Usual refactoring                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Feature envy                | Method uses another object's data more than its own                         | Move method to where the data lives                                                                                |
| Data clumps                 | Same 3+ fields passed together                                              | Introduce value object                                                                                             |
| Primitive obsession         | Strings/numbers standing in for domain concepts (IDs, money, units)         | Value types, branded types, enums                                                                                  |
| Shotgun surgery             | One change requires edits in many files                                     | Gather the scattered logic into one module                                                                         |
| Divergent change            | One module changes for many unrelated reasons                               | Split by reason to change                                                                                          |
| Message chains              | `a.getB().getC().getD()`                                                    | Hide delegate / introduce a query method                                                                           |
| Middle man                  | Class that only forwards                                                    | Remove it; call the target directly                                                                                |
| Repeated switch on type     | Same discriminator switched in 2+ places                                    | Lookup table or polymorphism (see architecture.md)                                                                 |
| Magic numbers/strings       | Unexplained literals, repeated                                              | Named constants                                                                                                    |
| Flag arguments              | Boolean that selects behavior                                               | Separate functions                                                                                                 |
| Temporal coupling           | Methods must be called in a hidden order                                    | Make the order explicit (builder, constructor args, single entry point)                                            |
| Inconsistent error handling | Mix of throw, return null, return error object for the same kind of failure | Pick the project's dominant convention (only where callers already handle both — otherwise it's a behavior change) |
| Mutable shared state        | Module-level mutable variables mutated from several places                  | Encapsulate behind a module API                                                                                    |
| Boolean soup                | `isLoading`, `isError`, `isSuccess` flags                                   | Discriminated union / state machine (see architecture.md for the trap)                                             |
