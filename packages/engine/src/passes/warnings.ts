// Folds the warning drafts raised by passes into one `ModelWarning` per kind. A capture of a real
// program can mention hundreds of files; the model carries a count and a few samples instead.

import type { ModelWarning } from '../model.js';
import { plural } from '../util/format.js';
import type { WarningDraft } from './types.js';

const MAX_DETAILS = 20;

const SUMMARY: Record<string, (n: number) => string> = {
  'no-profile': (n) =>
    `${n} ${plural(n, 'track has', 'tracks have')} no CPU profile; shown without samples.`,
  'invalid-pattern': (n) =>
    `${n} ${plural(n, 'configured pattern was', 'configured patterns were')} ignored: not a valid regular expression.`,
  'invalid-focus': (n) =>
    `${n} focus ${plural(n, 'glob was', 'globs were')} ignored: not a valid pattern.`,
  'source-map-invalid': (n) =>
    `${n} source ${plural(n, 'map', 'maps')} could not be parsed; showing generated code.`,
  'source-map-missing': (n) =>
    `${n} ${plural(n, 'file', 'files')} of the target ${plural(n, 'has', 'have')} no source map; showing generated names and lines.`,
  'dependency-source-map-missing': (n) =>
    `${n} dependency ${plural(n, 'file has', 'files have')} no source map; names are generated names, which is expected.`,
};

export function buildWarnings(drafts: readonly WarningDraft[]): ModelWarning[] {
  const byKind = new Map<string, WarningDraft[]>();
  for (const d of drafts) {
    const list = byKind.get(d.kind);
    if (list) list.push(d);
    else byKind.set(d.kind, [d]);
  }
  const out: ModelWarning[] = [];
  for (const [kind, list] of byKind) {
    const details = [...new Set(list.map((d) => d.detail))];
    const severity = list.some((d) => d.severity === 'warn') ? 'warn' : 'info';
    const summary = SUMMARY[kind]?.(list.length) ?? `${list.length} × ${kind}`;
    out.push({
      kind,
      severity,
      summary,
      count: list.length,
      details: details.slice(0, MAX_DETAILS),
    });
  }
  return out.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1) ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );
}
