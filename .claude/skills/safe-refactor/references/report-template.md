# Ledger and report formats

## Findings ledger: `.refactor/findings.md`

The ledger is the source of truth for the run. Keep it updated after every status change so work can resume after compaction or in a new session.

```markdown
# Refactor ledger

Scope: src/checkout, src/styles · Branch: refactor/safe-refactor-20261017 · Started: 2026-10-17
Health before: 412 tests, 2 failing (see health-before.md) · typecheck ✓ · lint 3 warnings · build ✓

## Summary
| Category | refactor | defer | leave |
| --- | --- | --- | --- |
| dead-code | 6 | 1 | 0 |
| css-tokens | 4 | 0 | 2 |
| ... | | | |

## Findings

### F-001 · dead-code · src/utils/format.ts:42 `formatLegacyDate`
- Evidence: knip reports unused export; no string references in repo (searched ts/tsx/json/yaml/md); not in package.json exports
- Impact: low · Confidence: certain · Risk: low · Effort: S
- Decision: refactor. Removes 38 lines and the last import of moment.js.
- Behavior surface: none (unreferenced)
- Test strategy: tooling proof (typecheck + build + full suite)
- Depends on: none
- Status: done (a1b2c3d)

### F-007 · css-zindex · src/components/** (14 distinct values)
- Evidence: scan-css z-index inventory; values 1, 2, 5, 10, 99, 100, 999, 1000, 9999...
- Impact: medium · Confidence: likely · Risk: high · Effort: M
- Decision: defer. Needs visual verification; project has no screenshot tooling.
- Status: deferred

## Bugs found (behavior preserved, decision needed)
- B-1 · src/cart/total.ts:88: discount applied before tax for region "CA" only; pinned by cart.baseline.test.ts "CA discount order"

## Near-miss values (design decision, not changed)
- font-size 15px (4 uses) vs token --font-md 16px
- #333 (7 uses) vs token --color-text #323232

## Approval items
- A-1 · Add dependency `clsx` (replaces 3 hand-rolled class joiners, 0.5 kB)
```

**Field values**
- Category: `dead-code`, `purity`, `duplication`, `god-function`, `params`, `speculative`, `comments`, `best-practice`, `coupling`, `pattern-misuse`, `pattern-apply`, `react-isolation`, `react-purity`, `library`, `perf`, `css-position`, `css-zindex`, `css-important`, `css-tokens`, `css-other`, `smell`
- Impact (how much better the code gets): `high` / `medium` / `low`
- Confidence (that it's a real problem): `certain` / `likely` / `suspect`
- Risk (of an unintended behavior change): `low` / `medium` / `high`
- Effort: `S` (under 30 min) / `M` / `L` (consider splitting)
- Decision: `refactor` / `defer` (worth doing but blocked: needs approval, visual tooling, or an unpinnable surface) / `leave` (not worth doing; reason required)
- Status: `new` → `approved` → `baselined` → `in-progress` → `done` | `reverted` | `deferred` | `leave`

## Final report: `.refactor/REPORT.md`

```markdown
# Refactor report: <scope>

## Outcome
<2–3 sentences: what got better, and the evidence that behavior is unchanged>

## Verification
- Baseline tests: N added across M files, locked, unchanged (baseline_guard verify ✓)
- Full suite: <before> → <after> (same pre-existing failures: ...)
- Typecheck ✓ · Lint <before → after> · Build ✓
- Visual checks: <method and result, or "not applicable">

## Changes
| ID | Category | Summary | Commit |
| --- | --- | --- | --- |

## Measured deltas
| Metric | Before | After |
| --- | --- | --- |
| Lines of code (scope) | | |
| Functions over 80 lines | | |
| Max parameters | | |
| !important | | |
| Distinct z-index values | | |
| Repeated literal values | | |
| Circular dependencies | | |
| Benchmarks | | |

## Reverted
<ID, what was tried, why it failed>

## Deferred and left alone
<ID, one-line reason each>

## Bugs found (behavior preserved)
<ID, location, description, the test that pins it>

## Needs a decision
<approval items not yet granted, near-miss values, suggested follow-ups>
```
