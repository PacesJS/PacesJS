---
paths:
  - 'packages/engine/**'
  - 'packages/format/**'
---

# Engine and format rules

- Zero imports of `node:*`, `fs`, `path`, `Buffer`, `process`, `window`, `document`. Enforced by tsconfig (`types: []`, no DOM lib), ESLint and `pnpm check:boundaries`. For I/O, accept data as arguments (`Uint8Array`, strings) and let the caller read and write.
- Each of the ten passes is one module exporting one pure function `(input, ctx) => output`, with its own test file and golden fixtures. Passes run in the fixed order from the spec; do not skip or reorder.
- Model tables are columnar typed arrays plus the shared string table. Strings are interned once. Row ids are indexes; never store object references in the model.
- Mark, never delete: plumbing and non-user frames are flagged (`plumbing`, `origin`); removal happens only in UI transforms.
- Timestamps are absolute microseconds in `Float64Array`. Precision is carried in `meta.precision`.
- Deterministic output: sort with explicit tie-breakers so snapshots are stable across platforms, and normalize path separators to `/`.
- Format: `manifest.formatVersion` is semver. Readers accept any minor of their major and refuse newer majors with a clear message. Never rewrite raw data; the model cache is disposable.
- Findings: pure rule functions with thresholds passed in config and echoed inside each finding. One sentence, one number, evidence rows, a `showMe` target.
