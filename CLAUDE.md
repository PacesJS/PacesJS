# pacesJS

`paces` profiles a Node command (`npx paces -- node app.js`) and opens a UI that shows what the JavaScript did in linked views. Spec: `docs/JS Execution Profiler — Technical Design.md` (written under the old name "Trailmap"). Design boards: `docs/*.png`, source `docs/Trailmap — Node profiler.html`.

**Naming: Trailmap → paces.** Org/scope `@pacesjs`, CLI `paces`, sessions `.paces` in `./.paces/`, env `PACES_SESSION` / `PACES_SOCKET`. Never write "trailmap" in code, UI copy or new docs.

## Layout

pnpm workspace + Turborepo, TypeScript, ESM everywhere.

| Path                      | Role                                                | Constraints                                                      |
| ------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/engine`         | Passes, execution model, query/transform layer      | No Node, no DOM. `lib: ES2022`, `types: []`                      |
| `packages/format`         | `.paces` read/write (zip via fflate)                | No Node built-ins; takes/returns `Uint8Array`                    |
| `packages/collector-node` | Preload scripts, socket client, flush               | Node built-ins only, zero deps                                   |
| `packages/ui`             | React 19 + Vite view bundle, `HostAdapter`          | Talks to the host only through `HostAdapter`                     |
| `packages/paces`          | Published CLI; bundles everything via tsup          | Runtime deps must be pure JS; no native binaries, no postinstall |
| `zoo/`                    | Bottleneck zoo: tiny apps, one planted problem each | Deliberately naive code; excluded from lint                      |
| `e2e/`                    | Playwright + CLI end-to-end tests                   |                                                                  |

Data flows one way: raw chunks (target) → finished model (CLI) → queries (UI worker). Packages depend downward only; import another package only through its public entry.

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

## Honest data rules (product behavior)

Sampled timings are estimates: prefix `~`, label precision (`±1 ms`), hatch bars under two sampling intervals. Exact data (instrumentation) drops the `~`. Red and amber mean finding severity only. Dim non-user frames to 45%, never hide them. Folded things are always expandable.

## Product lessons

- **The profiled program is first-party.** When the entry script lives in `node_modules` (e.g. `npx eslint .`), that package is the _target_: its functions are origin `User`, not `Dependency`. Otherwise collapse-dependencies folds the whole program into one node. Its plugins and libraries stay dependencies. Wrapper processes (npx, npm) are `support` tracks; the default track is the target.
- Test the tool on real third-party CLIs, not only the zoo. `paces -- npx eslint .` is the reference scenario: you must be able to name ESLint's own hot paths and the slow plugin functions from the UI and from `paces mcp`.
- Warnings are aggregated (one note per kind); never print one line per file.
- Live zoo runs vary with machine load: assert committed captures exactly (engine tests), assert only the planted finding's presence on live runs (e2e).
- **Cached models carry a column fingerprint** (`packages/engine/src/model-shape.ts`). Any added model column is picked up automatically; never ship a model change with a stale cache still loadable. UI query failures must log their stack (`console.error` in `app/hooks.ts`).
- **Verify on a real session, not only fixtures.** Fixtures analyze fresh and hide cache, scale and shape problems. Before calling UI work done, open a real `.paces` of `npx eslint .` through the built CLI (`paces open <file> --no-open`) and look at it.

## Git

Conventional commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`), small and focused, tests and implementation together. Do not commit `.paces` files, `dist/`, or screenshots outside `e2e/`.

## Windows

Development happens on Windows. Use `pathToFileURL()` for `--import`, quote paths in `NODE_OPTIONS`, use named pipes `\\.\pipe\paces-<id>` instead of Unix sockets, and never assume `SIGINT` can be sent to a child (on Windows it kills it). Scripts must run under both PowerShell and bash, so prefer Node scripts (`scripts/*.mjs`) over shell.

Per-file-type rules live in `.claude/rules/` (engine and format, UI, tests, collector and CLI, docs and config).
