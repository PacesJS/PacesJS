---
paths:
  - 'packages/collector-node/**'
  - 'packages/paces/**'
---

# Collector and CLI rules

- Preload code runs inside the user's process: tiny, no dependencies, no allocation in hot paths, no change to the target's behavior (rethrow after flushing, never alter exit codes, forward signals).
- The final profile is written with `fs.writeFileSync` in the `exit` handler (synchronous only). The socket carries live events and control messages, never the final payload.
- `NODE_OPTIONS` is appended to, never replaced. The ESM preload path goes through `pathToFileURL(...).href`; quote paths with spaces. Both `--require` (cjs) and `--import` (mjs) entries ship.
- Connect through the path in `PACES_SOCKET`, not the `ipc` fd (grandchildren do not inherit it).
- Ctrl+C (R11): the CLI catches SIGINT, sends `stop`, waits up to 5 s for flushes, then lets the app's own shutdown run; a second Ctrl+C kills immediately. Verify on Windows, where default SIGINT and `child.kill` do not behave like POSIX.
- CLI: parse flags before `--` and pass everything after it untouched. The exit code of `paces -- <cmd>` mirrors the target's. Terminal output is plain, short and actionable; errors say what to do next. Nothing leaves the machine; no telemetry.
- Server: bind `127.0.0.1` on a random port, require a random 32-byte token on every request, and restrict source reads to the recorded project root (resolve and `realpath` first, then check the prefix).
- Runtime deps of the published `paces` package are pure JS and bundled (tsup `noExternal`). A test inspects `dist` and the dependency tree to enforce this.
