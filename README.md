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

| `paces --report -- <cmd...>` | Profile, print a report with drill-down commands, exit |
| `paces report <file> [flags]` | Drill into a saved session (`.paces` or `.cpuprofile`) |
| `paces guide` | Print a short usage guide to paste into `AGENTS.md` |

Flags: `--interval <µs>` (default 1000), `--async` (record async causality, opt-in), `--duration <s>`, `--out <file>`, `--embed-sources`, `--no-open`, `--include <glob>` / `--exclude <glob>`. `--start-on <signal>` is not available on Windows; use `--duration`.

### Marks and hotkeys for long-running programs

For a server or anything that does not exit by itself, paces keeps a status panel on the bottom rows of the terminal (a spinner, how long it has been profiling, and the keys below); the program's own output scrolls above it. Where the panel does not fit, paces prints a line every 10 s instead. In a terminal it also reads three keys:

| Key      | Does                                                                                          |
| -------- | --------------------------------------------------------------------------------------------- |
| `m`      | Add a mark (`Mark 1`, `Mark 2`, ...) at this moment. Press it just before you send a request. |
| `s`      | Stop profiling, end the program and open what was collected.                                  |
| `Ctrl+C` | Stop profiling and let the program shut itself down, then open the results.                   |

The keys are on from the start, so paces holds the keyboard and the program gets an empty stdin (it sees end of input at once). That keeps every process the command starts, such as the `npx` wrapper, from reading your keystrokes or changing the terminal mode. For a program that reads stdin (a prompt, a REPL), run with `--no-keys`; paces then never touches stdin, and marks and the `s` key are not available (Ctrl+C still works). If a program tries to read stdin while the keys are on, paces says so in the panel and in a line. In the UI, each mark is a flag on the Tracks timeline; its menu focuses on the time before it, after it, or between it and another mark.

Sessions are saved to `./.paces/` as timestamped `.paces` files. Sampled timings are estimates and are labelled that way (`~`, `±` precision).

## Reports for people and agents (no window)

```sh
paces --report -- npx eslint .                       # profile, print the report, exit with the command's exit code
paces report .paces/<file>.paces --tree --from runRules
paces report .paces/<file>.paces --lines f1234
```

`--report` saves the session as usual, prints a compact summary and ends with `next:` lines holding the exact commands to drill down. It never opens a window or waits for a browser (`--no-open` still means "print the URL and wait"). Output is plain text without colour when stdout is not a terminal; `--json` gives a stable schema (`schemaVersion: 1`) for every view.

Views of `paces report <file>` (default: the summary):

| Flag                  | Shows                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| `--tree`              | Top-down call tree with total, share and self time per row                 |
| `--callers <sel>`     | Who calls a function, with the time split by caller                        |
| `--callees <sel>`     | What a function spends its time in (a tree rooted at it, depth 3)          |
| `--top self\|total`   | Function ranking (combine with `--origin`, `--pkg`, `--limit`)             |
| `--pkg <name>`        | The hot functions of one package, e.g. a plugin                            |
| `--lines <sel>`       | Source lines with ms per line and the code (hot lines marked), callee time |
| `--phases`, `--tasks` | Startup vs main work; one row per task (drill in with `--task <n>`)        |

Selectors (`<sel>`, `--from`): a function name (`runRules`), an id from earlier output (`f123`, stable for that session file and engine version), `file.js:1007` (definition line, path suffix), or a name path `verify,runRules,traverseSync` where each step is a descendant, not necessarily a child. Matching is case-sensitive, exact first, then substring (the output says which). An ambiguous name lists its candidates with ids and exits with code 1. Quote selectors that contain spaces; commas and `:` need no quoting in bash or PowerShell 7.

Shaping: `--depth N` (6), `--min-share 1%` / `--min-ms N` (rows below are folded and counted), `--sort total|self|time`, `--limit N`, `--origin user,dependency,node,native,gc` (hidden frames fold into their caller, like the UI's Show filter), `--expand <pkg>` / `--no-collapse` (dependencies are collapsed into one `▸ pkg` row by default, as in the UI), `--task <n|whole>`, `--track <id|primary>` (default: the target process), `--max-lines N` (60, never exceeded), `--no-color`, `--focus <pkg|glob>` (rank that package first).

How to read it: times are sampled estimates (`~`, precision `±` in the header), ms below ten seconds and seconds above; `share` is relative to the whole view (the run, or the chosen task) and thresholds are relative to the root row; async continuations are stitched under the call that started them, which is inferred; startup (module loading) can dominate short runs. `paces guide` prints this as a guide for `AGENTS.md` or `CLAUDE.md`.

`paces mcp <file>` serves the same data over MCP (stdio) with the tools `summary`, `findings`, `hot_paths`, `top_functions`, `package_breakdown`, `callers` and `phases`; the CLI reports above need no client setup.

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
