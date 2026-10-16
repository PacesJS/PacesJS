# paces

Profile a Node command and read what the JavaScript did.

```sh
npx paces -- node app.js
```

`paces` runs your command unchanged, samples it with V8's CPU profiler, and when it exits (or you press Ctrl+C on a server) opens a window with linked views of the run: a findings summary, a track timeline, a waterfall, a flame graph, a call graph, a functions table and the source, all driven by one selection. Nothing leaves your machine, and there are no native binaries to compile.

## Usage

| Command                               | Purpose                                                       |
| ------------------------------------- | ------------------------------------------------------------- |
| `paces [flags] -- <cmd...>`           | Profile a command, then open the UI                           |
| `paces open <file.paces>`             | Reopen a saved session                                        |
| `paces diff <a.paces> <b.paces>`      | Compare two sessions (differential flame graph)               |
| `paces import <file>`                 | Open a `.cpuprofile` or DevTools trace JSON                   |
| `paces summary <file.paces> [--json]` | Print findings in the terminal                                |
| `paces mcp <file.paces>`              | Serve the findings summary to a coding agent over stdio (MCP) |

Flags: `--interval <µs>` (default 1000), `--async` (record async causality, opt-in), `--duration <s>`, `--out <file>`, `--embed-sources`, `--no-open`, `--include <glob>` / `--exclude <glob>`. `--start-on <signal>` is not available on Windows; use `--duration`.

Sessions are saved to `./.paces/` as timestamped `.paces` files. Sampled timings are estimates and are labelled that way (`~`, `±` precision).

## Repository

pnpm workspace with Turborepo and TypeScript.

| Package                   | Role                                                                         |
| ------------------------- | ---------------------------------------------------------------------------- |
| `paces`                   | The published CLI, bundled for `npx`                                         |
| `@pacesjs/engine`         | Analysis passes, execution model, query and transform layer (no Node or DOM) |
| `@pacesjs/format`         | `.paces` session reader and writer                                           |
| `@pacesjs/collector-node` | Preload scripts and control socket that run inside the target                |
| `@pacesjs/ui`             | React view bundle and the `HostAdapter` interface                            |
| `zoo/`                    | Bottleneck zoo: tiny apps, each with one planted problem                     |

```sh
pnpm install
pnpm build
pnpm test          # unit and integration
pnpm test:e2e      # CLI and UI end-to-end, including screenshot tests
pnpm lint
pnpm fixtures      # regenerate engine fixtures from the zoo
pnpm --filter @pacesjs/ui dev   # UI on the orders-server fixture
```

Contributing rules (TDD, code style, per-file-type conventions) are in `CLAUDE.md` and `.claude/rules/`. The original design is in `docs/`; it predates the rename from "Trailmap".

## License

MIT
