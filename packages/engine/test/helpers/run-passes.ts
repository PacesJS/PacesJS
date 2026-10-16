import { classify } from '../../src/passes/classification.js';
import { ingest } from '../../src/passes/ingest.js';
import { detectPlumbing } from '../../src/passes/plumbing.js';
import { resolveSourceMaps } from '../../src/passes/source-maps.js';
import type { WarningDraft } from '../../src/passes/types.js';
import type { AnalyzeOptions } from '../../src/config.js';
import { DEFAULT_THRESHOLDS } from '../../src/config.js';
import { Origin, ORIGIN_NAMES } from '../../src/model.js';
import type { RawCapture } from '../../src/raw.js';
import { createStringTable } from '../../src/util/strings.js';

export function runPasses(capture: RawCapture, options: AnalyzeOptions = {}) {
  const ctx = {
    thresholds: DEFAULT_THRESHOLDS,
    options,
    strings: createStringTable(),
    warnings: [] as WarningDraft[],
  };
  const ing = ingest(capture, ctx);
  const sm = resolveSourceMaps({ capture, ingest: ing }, ctx);
  const cls = classify(sm.functions, ctx);
  const plumbing = detectPlumbing({ functions: sm.functions, classification: cls }, ctx);
  const s = ctx.strings.strings;
  /** Every function as a readable record, for assertions. */
  const functions = Array.from({ length: sm.functions.length }, (_, fn) => ({
    fn,
    name: s[sm.functions.name[fn] ?? 0] ?? '',
    file: s[sm.functions.file[fn] ?? 0] ?? '',
    line: sm.functions.line[fn] ?? 0,
    col: sm.functions.col[fn] ?? 0,
    origin: ORIGIN_NAMES[cls.origin[fn] ?? Origin.User] ?? 'user',
    pkg: s[cls.pkg[fn] ?? 0] ?? '',
    plumbing: plumbing[fn] === 1,
  }));
  return { ctx, ing, sm, cls, plumbing, functions };
}
