# Baseline (characterization) testing

A characterization test records what code **does**, not what it should do. It is the safety net that lets a refactor prove behavior didn't change. Rules of thumb:

- Assert current behavior, including warts and bugs. A test that "fixes" a bug in its expectation will fail on the unchanged code — which is how you know it's wrong.
- Test through the public surface the refactor won't touch: exported functions, component props and rendered output, HTTP endpoints, CLI invocations. Tests that import private helpers break when the helpers move.
- Prefer many small, precise assertions over one giant snapshot. Use snapshots for complex output where writing assertions by hand is impractical, and review each snapshot once when created.
- Make every test deterministic before locking it.

## Naming and location

Follow the project's test conventions for location and runner. Name new files `*.baseline.test.<ext>` (or `test_*_baseline.py` for pytest) so they're easy to lock, find, and later rename into the regular suite. Inside, prefix describe blocks with `baseline:`.

## Coverage target

For each function or component the refactor will change, every branch should be executed by at least one baseline or existing test. Use the runner's coverage scoped to the target files (`vitest --coverage --coverage.include=src/foo.ts`, `jest --coverage --collectCoverageFrom=src/foo.ts`, `pytest --cov=pkg.module --cov-branch`). Where a branch can't be reached in a test, note it in the ledger with the reason.

## Choosing inputs

- Harvest real inputs from call sites, fixtures, seed data, and existing tests.
- Add boundaries: empty, single, many; `null`/`undefined`/`None`; `0`, negative, very large, `NaN`; empty string, whitespace, unicode and emoji, very long strings; unsorted and duplicate data; invalid inputs that throw.
- For anything with branches on type or shape, one input per branch.

## Differential (oracle) testing

For pure functions with large input spaces (parsers, formatters, calculations), copy the original implementation to `.refactor/oracle/<name>.<ext>` before refactoring, and add a temporary test that compares old vs. new over many generated inputs (fast-check for JS/TS, Hypothesis for Python). This catches differences no hand-picked example would. The oracle test is temporary scaffolding: remove it in Phase 6 and keep the example-based baseline tests.

## Determinism checklist

- Time: fake timers (`vi.useFakeTimers()`, `jest.useFakeTimers()`), fixed system time; Python `freezegun`/`time-machine`.
- Randomness: seed or stub `Math.random`/`crypto.randomUUID`; `random.seed`.
- Network: mock at the boundary (MSW, nock, `responses`, `respx`); never hit real services.
- Ordering: don't depend on object key order from unordered sources, filesystem listing order, or `Promise` race outcomes.
- Environment: pin locale and timezone (`TZ=UTC`) for formatting tests.
- Isolation: reset module state, singletons, and DOM between tests.
- Format and lint the test files with the project's tools first; a locked file that fails lint can't be fixed later without re-locking.
- Run three times; also once with the runner's random-order option if it has one (`vitest --sequence.shuffle`, `jest --randomize`, `pytest -p random_order`).

## Recipes by stack

### JS/TS (Vitest or Jest)

```ts
import { describe, it, expect, vi } from 'vitest';
import { priceWithTax } from '../src/pricing';

describe('baseline: priceWithTax', () => {
  it.each([
    [100, 'US', 108.25],
    [0, 'US', 0],
    [-5, 'US', -5.41], // current behavior: negative prices allowed
    [100, 'XX', 100], // unknown region: no tax
  ])('priceWithTax(%s, %s) = %s', (amount, region, expected) => {
    expect(priceWithTax(amount, region)).toBe(expected);
  });

  it('throws on NaN', () => {
    expect(() => priceWithTax(NaN, 'US')).toThrowErrorMatchingInlineSnapshot();
  });
});
```

Side-effect order: spy on the collaborators and assert `mock.calls` and `mock.invocationCallOrder`. Inline snapshots (`toMatchInlineSnapshot()`) are filled on first run — read what got filled in before locking.

### React components

See react.md §6. Render, query by role, interact with user-event, assert DOM and callback calls; `asFragment()` snapshot as a markup net.

### HTTP services

Drive the app in-process (supertest, `fastify.inject`, FastAPI `TestClient`) and assert status, headers that matter, and body for each route and error path touched.

### Python (pytest)

`@pytest.mark.parametrize` tables; `pytest.raises(ExcType, match=...)` for errors; syrupy or approvaltests for snapshots; `monkeypatch` for environment and collaborators; `caplog` if logs are consumed.

### CLIs and scripts

Run the command with fixed inputs and compare stdout, stderr, exit code, and files written, against recorded golden files under the test fixtures directory.

### CSS / visual

See css.md §6. Prefer compiled-CSS diff for substitutions, screenshot comparison for layout, computed-style snapshots in a real browser otherwise. jsdom can't verify layout.

## Mutation sanity check

Before locking, prove the tests can fail. For each target, make 2–3 small deliberate behavior changes (flip a comparison, delete a branch, swap two operands, return early), run the baseline tests, confirm each mutation produces failures, then restore the file (`git checkout -- <file>`). A mutation that survives means a gap in the baseline: add a case, then repeat.

## Locking

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/baseline_guard.py lock path/to/a.baseline.test.ts path/to/b.baseline.test.ts
python3 ${CLAUDE_SKILL_DIR}/scripts/baseline_guard.py verify
python3 ${CLAUDE_SKILL_DIR}/scripts/baseline_guard.py status
```

`lock` records SHA-256 hashes in `.refactor/baseline.lock.json` (adding to any existing lock). `verify` exits non-zero if any locked file changed or disappeared. If a module move forces an import-path update, use `lock --update <file>` after making only that change, and log it in the ledger.
