// Folds the warning drafts raised by passes into one `ModelWarning` per kind. A capture of a real
// program can mention hundreds of files; the model carries a count and a few samples instead.

import type { ExecutionModel, ModelWarning } from '../model.js';
import type { CaptureMeta } from '../raw.js';
import { compareText } from '../util/compare.js';
import { plural } from '../util/format.js';
import type { WarningDraft } from './types.js';

const MAX_DETAILS = 20;

/** One draft per process or worker that was stopped before it wrote a profile. */
export function lostTrackDrafts(lost: CaptureMeta['lostTracks']): WarningDraft[] {
  return (lost ?? []).map((t) => {
    const pid = t.pid === undefined ? undefined : `pid ${t.pid}`;
    const detail =
      pid === undefined
        ? (t.label ?? t.id)
        : t.kind === 'worker'
          ? `${pid} (worker ${t.threadId ?? '?'})`
          : pid;
    return { kind: 'lost-tracks', severity: 'warn' as const, detail };
  });
}

/**
 * Makes sure a model carries what the capture says about lost tracks. A model cached before the host knew
 * about them lacks the warning; call this after loading a cached model with the capture's meta. Idempotent.
 */
export function ensureCaptureWarnings(
  model: ExecutionModel,
  meta: Pick<CaptureMeta, 'lostTracks'>,
): ExecutionModel {
  const drafts = lostTrackDrafts(meta.lostTracks);
  if (drafts.length === 0 || model.meta.warnings.some((w) => w.kind === 'lost-tracks'))
    return model;
  return {
    ...model,
    meta: {
      ...model.meta,
      lostTracks: meta.lostTracks,
      warnings: [...buildWarnings(drafts), ...model.meta.warnings].sort(
        (x, y) => Number(y.severity === 'warn') - Number(x.severity === 'warn'),
      ),
    },
  };
}

const SUMMARY: Record<string, (n: number) => string> = {
  'lost-tracks': (n) =>
    n === 1
      ? '1 process or worker was stopped before it could write a profile; its time is not in this session.'
      : `${n} processes or workers were stopped before they could write a profile; their time is not in this session.`,
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
  'target-package-source-map-missing': (n) =>
    `${n} ${plural(n, 'file', 'files')} of the target package ${plural(n, 'has', 'have')} no source map; names are generated names, which is expected for published packages.`,
  'app-site-inferred': (n) =>
    n === 1
      ? 'Most of the code that ran came from one other site, so it is counted as your own code. Use --first-party to change that.'
      : 'Most of the code that ran came from other sites, so it is counted as your own code. Use --first-party to change that.',
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
      compareText(a.kind, b.kind),
  );
}
