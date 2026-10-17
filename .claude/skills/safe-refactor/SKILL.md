---
name: safe-refactor
description: Behavior-preserving refactoring of a repository or directory. Scans for problems, classifies them, writes baseline characterization tests, refactors in small verified steps, and proves behavior is unchanged. Covers dead code, impure functions/components, duplication, god functions, long parameter lists, tight coupling, misused or missing architectural patterns, non-isolated React components, speculative generality, noisy comments, hand-rolled code an available library already does, performance bottlenecks, and CSS problems (absolute positioning, z-index, !important, duplicated font-size/spacing/border values). Use whenever the user asks to refactor, clean up, tidy, reduce tech debt, remove dead code, deduplicate, decouple, or make a codebase better without changing what it does, even if they never say "refactor". Not for adding features, fixing bugs, or reviewing a single PR diff.
allowed-tools: Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/*)
---

# Safe Refactor

Improve the structure of a codebase without changing what it does. The run has six phases: prepare, scan, classify, baseline, refactor, validate. Each phase writes to `.refactor/` at the repo root, so the work survives context compaction and can be resumed in a new session.

Scope: `$ARGUMENTS`. This can be a path, a glob, or category names (`css`, `react`, `dead-code`, `perf`...). If empty, the whole repository. If the user only wants an assessment ("audit", "what would you change", "report only"), run Phases 0–2 and stop at the checkpoint with the ledger as the deliverable.

## Non-negotiables

These hold for the entire run. When resuming or after compaction, re-read this section first.

1. **Behavior is frozen.** Observable behavior means: return values; thrown errors and their types; side effects and their order; rendered markup and the accessibility tree; computed styles and layout; public API shape (exports, signatures, routes, events, CLI flags, config keys); serialized/persisted formats; log or telemetry output that something consumes. Performance may improve. Nothing else changes.
2. **Bugs are preserved, not fixed.** When you find one, pin the current behavior in a baseline test, log it under "Bugs found" in the ledger, and keep going. Fixing it is a separate, behavior-changing decision for the user.
3. **Baseline tests are the contract.** Once locked, never edit, skip, loosen, or delete them to make a refactor pass. If a refactor seems to need a test change, the refactor changed behavior: revert it. The only exception is a mechanical import-path update when a module moves, logged in the ledger. Writing baseline tests against public entry points avoids even that. Existing snapshot files are part of the contract too: never run snapshot-update modes (`-u`, `--update`, `test:update`), even if the repo's own docs say to.
4. **Only refactor what gets better.** Every change passes the quality gate below. "Nothing here is worth changing" is a valid result for any file or category.
5. **One finding, one commit, green in between.** Never stack unverified changes. A red check means revert that finding, not debug forward into a pile of edits.
6. **Ask first** before adding a dependency, changing an exported or public API, deleting a file that could be loaded dynamically, touching generated or vendored code, or going outside the scope the user gave.

## The quality gate

A finding becomes a refactor only if all of these are true:

- The improvement fits in one sentence about what gets easier (to read, change, test, reuse) or measurably faster.
- Net complexity goes down: fewer concepts, branches, files, or indirections for a reader to hold. Or it stays equal with a concrete gain, such as one implementation instead of three.
- Behavior can be pinned: baseline tests cover it, or the change is provably neutral by tooling (type checker, compiler, compiled-CSS diff, unused-symbol analysis).
- It fits the codebase's existing conventions. If the repo already has a pattern, follow it instead of introducing a competing one. Consistency beats a textbook ideal.
- The risk is proportionate to the value.

Log a finding as `leave`, with the reason, when: the duplicates are coincidentally similar and likely to diverge; the abstraction would have a single implementation; the change is only a naming or formatting preference; the code is generated, vendored, or shaped by a framework convention; the "inefficiency" sits off any hot path and measurement shows nothing; or the only way to pin the behavior is a test so tied to internals that it would block the refactor.

## Phase 0: Prepare

1. Run `git status`. If the tree is dirty, ask the user to commit or stash; per-finding commits are what make clean reverts possible. Create the branch `refactor/safe-refactor-<YYYYMMDD>`.
2. Create `.refactor/` and add it to `.git/info/exclude`. This is a local-only ignore that leaves the team's `.gitignore` alone.
3. Profile the project:
   ```bash
   python3 ${CLAUDE_SKILL_DIR}/scripts/detect_project.py . > .refactor/project.json
   ```
   It reports languages, frameworks, styling approach, test runner, existing design tokens, the test, lint, typecheck, and build commands, and, for monorepos, each workspace package with whether it's published and which deep-import subpaths it exposes. Everything a published package exports, including those subpaths, is public API (non-negotiable 6). Then read CLAUDE.md, CONTRIBUTING, lint configs, and architecture docs. These define what "best practice" means for this repo, and they outrank generic advice.
4. Record the health baseline. Run the test suite, typecheck, lint, and build (in the background on large repos, while you scan), and save pass/fail counts plus the names of already-failing tests to `.refactor/health-before.md`. Pre-existing failures aren't yours to fix; they are the yardstick for "no new failures". If the tests can't run at all, stop and tell the user: without a runnable harness this skill can't guarantee behavior preservation. Offer to set up a minimal harness as a separate step.

**Resuming:** if `.refactor/findings.md` already exists, read it and continue from the first finding without a terminal status (`done`, `reverted`, `deferred`, `leave`).

## Phase 1: Scan

Use three sources. Each catches what the others miss.

1. **Bundled scanners** (fast heuristics):
   ```bash
   python3 ${CLAUDE_SKILL_DIR}/scripts/scan_code.py <scope> [<scope> ...] [--exclude <pattern> ...] > .refactor/scan-code.md
   python3 ${CLAUDE_SKILL_DIR}/scripts/scan_css.py <scope> [<scope> ...] [--exclude <pattern> ...] > .refactor/scan-css.md
   ```
   Pass several scopes in one call (`src packages/ui`). In `--exclude`, a bare name (`docs`, `fixtures`, `*.stories.tsx`) skips that folder or file name anywhere, and a pattern with `/` (`src/legacy`) skips that path and everything under it. Put `--exclude` after the scopes. Dependency and build folders, generated files, test files, dot-directories (`.claude`, `.github`), and the skill's own scripts are skipped automatically; a scope that doesn't exist is an error rather than a silent full-repo scan.
   `scan_code.py` reports long functions, long parameter lists and wide prop sets, deep nesting, large files, comment density, comments that restate the next line, and commented-out code (JS/TS with a heuristic tokenizer, Python via `ast`). `scan_css.py` reports `!important`, the z-index inventory, absolute/fixed positioning per file, repeated literal values, and literals that equal an existing design token. Both accept `--json`, and `--help` lists the thresholds.
2. **Ecosystem tools**, when they run without modifying the project: dead exports, duplication, dependency cycles, complexity, stylelint. Commands are in [references/tooling.md](references/tooling.md). Run them through `npx`/`pipx` with output into `.refactor/`, and don't add them to `package.json`.
3. **Reading the code.** Static tools can't judge purity, coupling, pattern misuse, component reusability, or hand-rolled reimplementations of a library. Read the files with the most scanner hits and the most-imported modules first. Load only the catalogs relevant to the stack and scope:
   - [references/smells.md](references/smells.md): dead code, purity, duplication, god functions, long parameter lists, speculative generality, comments, best-practice traps, other smells
   - [references/react.md](references/react.md): component isolation, reusability, render purity, hooks
   - [references/css.md](references/css.md): positioning, z-index, `!important`, repeated values and tokens
   - [references/architecture.md](references/architecture.md): coupling, misapplied patterns, patterns worth applying
   - [references/libraries.md](references/libraries.md): hand-rolled code versus built-ins and libraries
   - [references/performance.md](references/performance.md): bottlenecks and proving a fix

When roughly 300 or more source files are in scope, split the reading by top-level directory or category and run general-purpose subagents in parallel (read-only work), each given the relevant catalog paths and returning findings in the ledger format. Then merge and deduplicate.

Treat scanner output as leads, not verdicts. A 120-line function that is a flat, readable dispatch over message types may be fine. A 40-line function doing four jobs may not.

## Phase 2: Classify, gate, plan

Write every finding to `.refactor/findings.md` in the format from [references/report-template.md](references/report-template.md): ID, category, location, evidence, impact, confidence, risk, effort, decision (`refactor`, `defer`, or `leave`) with its reason, behavior surface, test strategy, and dependencies on other findings.

Order the approved refactors so early ones make later ones smaller and safer:

1. Dead code and commented-out code
2. Mechanical, tool-verifiable changes: exact-value token substitution, restating-comment removal, unused parameters of internal functions
3. Extractions: pure logic out of impure functions, splitting god functions, consolidating true duplicates
4. Component isolation and decoupling
5. Pattern application and library replacement
6. Performance, last, because structural changes often move the hot path

**Checkpoint with the user.** Present a short plan: counts by category and decision; the refactors in order; items needing approval (new dependencies, public API changes, risky deletions, layout-affecting CSS with no visual tooling); bugs noticed so far; and what was rejected, briefly, with reasons. Ask them to approve, trim, or reprioritize. This is the last cheap point to change direction. If the user said up front to proceed without asking, follow the plan, but still hold back the items in non-negotiable 6.

## Phase 3: Baseline tests

For each approved finding, batched by module, follow [references/baseline-testing.md](references/baseline-testing.md):

1. Map the behavior surface: callers, exports, rendered output, styles, side effects.
2. Check existing coverage of that surface, scoped to the target files if the runner supports it. Existing tests that already pin the behavior count; don't duplicate them.
3. Write characterization tests for the gaps. Assert what the code does now, including odd edge cases and current bugs. Test through public entry points so the tests survive the refactor. Cover typical inputs, boundaries (empty, null/undefined, zero, negative, very large, unicode), error paths, and side-effect order. For components, cover rendered output, accessible roles and names, and interactions.
4. Run the project's formatter and linter on the new test files, then run them three times against unchanged code (shuffled order if the runner supports it). They must pass every time. A flaky test is not a contract: fix determinism (fake timers, seeded randomness, fixed dates, mocked network) before locking.
5. Prove the tests can fail: plant two or three deliberate behavior changes in the target code (flip a condition, drop a branch, swap an operand), confirm the baseline tests catch each one, and restore the code. A test that stays green under mutation pins nothing.
6. Lock and commit them separately:
   ```bash
   python3 ${CLAUDE_SKILL_DIR}/scripts/baseline_guard.py lock <test files...>
   git commit -m "test: add baseline characterization tests for <area>"
   ```

CSS behavior is visual. In order of preference: compiled-CSS equivalence for pure value or token substitutions (build before and after, normalize, diff; identical output means no visual change); screenshot comparison if the project has Playwright or Storybook; computed-style snapshots in a real browser. If none is possible for a layout-affecting change (removing absolute positioning, z-index, or `!important`), mark the finding `defer: needs visual verification` rather than guessing.

## Phase 4: Refactor

First write `.refactor/verify.sh` with this project's per-finding checks: `baseline_guard.py verify`, the baseline tests plus existing tests for the affected packages, typecheck, and lint and format checks on changed files. Running the same script after every finding keeps verification consistent and cheap.

For each approved finding, in plan order:

1. Set its status to `in-progress` in the ledger.
2. Make the change in the smallest steps that keep the code compiling, following the recipe in the matching catalog. Update every call site in the repo.
3. Verify with `.refactor/verify.sh`, adding the test files of the main consumers when a shared utility changes. If the change touches the surface of a published package, also diff its emitted type declarations against the pre-refactor commit (see [references/tooling.md](references/tooling.md)); textual differences are acceptable only when the types are structurally identical, and the ledger says so.
4. Green: commit as `refactor(<category>): <summary> [F-NNN]` and mark it `done` with the commit hash. Red: discard this finding's uncommitted changes (`git restore --staged --worktree .` and remove any files it created) and mark it `reverted` with the failure reason. One retry with a smaller or different approach is fine when the cause is understood. Changing tests to get green is not (non-negotiable 3).
5. A new problem spotted mid-change goes into the ledger as a `new` finding. Don't widen the current change; the new finding needs the gate and a baseline like everything else.

Keep diffs focused. Drive-by reformatting, renames outside the finding, and import reshuffles in untouched files bury the real change in review.

## Phase 5: Validate

1. `python3 ${CLAUDE_SKILL_DIR}/scripts/baseline_guard.py verify` must report every baseline test unchanged.
2. Run the full suite, typecheck, lint, and build, and compare with `.refactor/health-before.md`. The failing set must be the same or smaller. Any new failure: bisect the refactor commits and revert the offending finding.
3. Re-run each performance benchmark and record before/after numbers. A performance change with no measured gain gets reverted, because it added complexity for nothing.
4. Re-run the CSS comparisons (compiled diff or screenshots) on the final state.
5. Re-run the scanners and record the deltas, for example `!important 23 → 4`, `functions over 80 lines 17 → 6`, `distinct z-index values 14 → 5`.

## Phase 6: Report

Write `.refactor/REPORT.md` from the final-report section of [references/report-template.md](references/report-template.md) and summarize it for the user: what changed by category with commit references, measured deltas, what was deferred or left and why, bugs found (behavior preserved, decision needed), and follow-ups such as adding visual regression tests to unlock deferred CSS work.

Then ask two things: whether to keep the baseline tests (recommended, since they are now regression tests; move them to the project's usual test locations if they aren't there already), and whether to delete `.refactor/`.
