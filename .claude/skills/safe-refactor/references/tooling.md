# Ecosystem detection tools

Run these read-only, with output in `.refactor/`. Use `npx --yes` / `pipx run` so nothing is added to the project's manifests. If a tool fails (offline, unsupported setup), note it in the ledger and rely on the other sources. Never install them as project dependencies without approval.

## JavaScript / TypeScript

| Purpose | Command |
| --- | --- |
| Unused files, exports, dependencies | `npx --yes knip --reporter json > .refactor/knip.json` (respects an existing `knip.json`; otherwise uses defaults that understand most frameworks) |
| Unused dependencies (fallback) | `npx --yes depcheck --json > .refactor/depcheck.json` |
| Duplication | `npx --yes jscpd <scope> --min-lines 6 --min-tokens 60 --reporters json --output .refactor/jscpd --ignore "**/*.test.*,**/dist/**,**/node_modules/**"` |
| Circular dependencies | `npx --yes madge --circular --extensions ts,tsx,js,jsx <src-dir>` |
| Dependency rules / layering | `npx --yes dependency-cruiser <src-dir> --config .refactor/depcruise.cjs --output-type err` (write the temporary config into `.refactor/`) |
| Complexity, length, params, nesting | Reuse the project's ESLint config and add rules from the CLI: `npx eslint <scope> --rule '{"complexity":["warn",15]}' --rule '{"max-params":["warn",4]}' --rule '{"max-lines-per-function":["warn",{"max":80,"skipBlankLines":true,"skipComments":true}]}' --rule '{"max-depth":["warn",4]}' -f json -o .refactor/eslint-metrics.json` |
| Type-aware unused code | `npx tsc --noEmit --noUnusedLocals --noUnusedParameters -p .` (read the errors as leads; don't change tsconfig) |
| Bundle composition | The project's analyzer if configured (`vite-bundle-visualizer`, `webpack-bundle-analyzer`, `source-map-explorer` on built sourcemaps) |

## Public API check for published packages

When a finding touches code exported by a published package, compare emitted declarations before and after:

```bash
R="$PWD"
git worktree add ../before <pre-refactor-commit>
ln -s "$R/node_modules" ../before/node_modules          # reuse installed deps
(cd ../before/<pkg> && npx tsc -p tsconfig.json --emitDeclarationOnly --declaration --outDir "$R/.refactor/dts-before")
(cd "$R/<pkg>" && npx tsc -p tsconfig.json --emitDeclarationOnly --declaration --outDir "$R/.refactor/dts-after")
diff -r .refactor/dts-before .refactor/dts-after
```

No diff means the type surface is unchanged. A diff is acceptable only if it's structurally identical (e.g. an inline type replaced by a local alias); record the reasoning in the ledger. Anything else is an API change and needs approval. Remove the worktree at the end (`git worktree remove ../before`).

## CSS

Write a temporary config to `.refactor/stylelint.json`:

```json
{
  "rules": {
    "declaration-no-important": true,
    "selector-max-id": 0,
    "selector-max-compound-selectors": 3,
    "declaration-block-no-duplicate-properties": [true, { "ignore": ["consecutive-duplicates-with-different-values"] }],
    "no-duplicate-selectors": true
  }
}
```

Run `npx --yes stylelint "<scope>/**/*.{css,scss,less}" --config .refactor/stylelint.json -f json > .refactor/stylelint.json.out`. For SCSS add `--custom-syntax postcss-scss`; for Less `postcss-less` (`npx --yes -p stylelint -p postcss-scss stylelint ...`).

## Python

| Purpose | Command |
| --- | --- |
| Dead code | `pipx run vulture <pkg> --min-confidence 80` |
| Complexity / maintainability | `pipx run radon cc <pkg> -s -n C` and `pipx run radon mi <pkg> -s` |
| Lints for complexity/params | `pipx run ruff check <pkg> --select C901,PLR0911,PLR0912,PLR0913,PLR0915,ERA001 --output-format json` (ERA001 = commented-out code) |
| Duplication | `npx --yes jscpd <pkg> --format python ...` or `pipx run pylint <pkg> --disable=all --enable=duplicate-code` |
| Import layering | `import-linter` if the project already configures contracts |

## Other ecosystems

- **Go:** `staticcheck ./...`, `deadcode ./...` (golang.org/x/tools), `golangci-lint run --enable dupl,gocyclo,gocognit,funlen`
- **Java/Kotlin:** PMD with CPD, SpotBugs, detekt (Kotlin), IntelliJ inspections if available
- **C#:** `dotnet build` analyzers (CAxxxx), Roslynator
- **Ruby:** `rubocop` Metrics cops, `flay` (duplication), `debride` (dead methods)
- **Rust:** `cargo clippy -- -W clippy::pedantic`, `cargo udeps`

## Reading results

All of these produce false positives in predictable places: framework entry points, dynamic imports, public APIs, generated code, and test utilities. Every tool hit is a lead that goes through "Proving it's dead" (smells.md §1) or the quality gate before it becomes a refactor.
