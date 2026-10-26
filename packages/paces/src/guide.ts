export const GUIDE = `# Profiling Node with paces (for coding agents)

When to profile: a command is slow, a server request is slow, or startup takes too long. Measure before
guessing. Run it on the real workload, not a toy input.

1. Profile and read the report in one step (no window, no server):
     paces --report -- <your command>          e.g. paces --report -- npx eslint .
   The exit code is your command's. The session is saved under ./.paces/ and the report ends with
   "next:" lines: copy-paste them to drill down.

2. Drill down on the saved session (paces report <file.paces> ...):
     --tree [--from SEL]     top-down call tree with time per row
     --callers SEL           who calls it, time split by caller
     --callees SEL           what it spends time in
     --top self|total        function ranking (add --pkg NAME to restrict to one package)
     --pkg NAME              hot functions inside one dependency
     --lines SEL             source lines with ms per line and the code (hot lines marked)
     --phases | --tasks      startup vs main work | one row per task (then --task N)
   A .cpuprofile works too: paces report app.cpuprofile

3. Selectors (SEL): a function name (runRules); an id from earlier output (f123, stable for that
   session file); file:line (linter.js:1007); a name path where each step is a descendant, not
   necessarily a child (verify,runRules,traverseSync). Ambiguous names exit non-zero and list
   candidates with ids; pick one by id.

4. Shaping: --depth N (6), --min-share 1% / --min-ms N (rows below are folded and counted), --sort
   total|self|time, --origin user,dependency,node,native,gc (hidden frames' self time moves up to
   the caller), --expand PKG or --no-collapse (dependencies are collapsed by default), --task N,
   --track ID, --max-lines N (60, hard cap), --json (stable schema, schemaVersion 1), --no-color.

Reading the numbers
- Everything is sampled (1 ms by default, about 1.6 ms on Windows): "~" means estimate. Differences
  below the printed precision (±) are noise. Rows under two intervals are not trustworthy.
- share = time of the row relative to the whole run (or the chosen task); self = time in the
  function's own code, total = including callees. Idle time is dropped.
- Startup (module loading) is often a large share of short runs: check --phases before optimizing.
- Async continuations are stitched under the call that started them; this is inferred, not exact.
- Dependencies appear as one collapsed row (▸ pkg); use --expand pkg to see inside plugins.
- Line numbers are original source lines (source maps applied); code text comes from disk or the
  source map, otherwise only numbers are shown.

V8 deoptimizations (opt in): add --v8 (paces --report --v8 -- node app.js). A "V8 keeps deoptimizing a
hot function" finding names a first-party function that is hot and that V8 repeatedly threw away
optimized code for, with the change that avoids it. Many runs have none: it only fires when the
deopts coincide with real time. V8 may print some trace lines to the program stdout in this mode.

With the paces MCP server registered (paces mcp), call its profile tool with the command as an array,
then summary, findings, hot_paths, callers and top_functions; list_sessions and open_session switch runs.

Workflow: summary -> heaviest subtree (--tree --from) -> hottest function (--lines) -> callers
(--callers) -> change code -> profile again and compare totals (paces diff a.paces b.paces).
`;
