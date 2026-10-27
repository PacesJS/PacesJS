import { useMemo } from 'react';
import { useApp } from './context';
import { useAsync } from './hooks';
import type { CallNumbers, Details, SourceInfo } from '../data/types';
import { matchCallSites } from '../view/call-sites';
import type { CallSiteChip } from '../view/call-sites';
import { lineWindow, rollUpToStatements } from '../view/source-lines';
import { isHostLost } from '../host/http';
import { fmtCount } from '../util/format';
import { formatMinified, looksMinified } from '../view/format-minified';
import type { FormattedSource } from '../view/format-minified';
import { sourceReason } from '../view/source-reason';
import type { SourceReason } from '../view/source-reason';

const TEXT = {
  acrossAllCalls: (count: string) => `across all ${count} calls`,
  acrossAll: 'across all calls',
} as const;

export interface SourceLine {
  n: number;
  text: string;
}

export interface SourceState {
  fn: number | null;
  info: SourceInfo | null;
  details: Details | null;
  /** Lines to draw: a window around the function, or the whole file. */
  lines: SourceLine[];
  /** Every line of the file ('' entries are empty lines); empty when the text is unavailable. */
  fileTexts: string[];
  /** The text was minified and has been laid out for reading: line numbers are not the file's. */
  formatted: boolean;
  /** The file changed on disk since the session was recorded. */
  changed: boolean;
  selfByLine: Map<number, number>;
  /** Where V8 threw away optimized code, by line (--v8 runs). */
  deoptsByLine: Map<number, SourceInfo['deopts']>;
  /** Lines V8 reported that were folded into the statement's first line, by that first line. */
  rolledFrom: Map<number, number[]>;
  /** Measurement precision in microseconds: a line under twice this is about one sample. */
  precisionUs: number;
  maxSelf: number;
  hottest: number;
  /** The line to select and scroll to: the definition, or the line the user jumped to. */
  targetLine: number;
  /** The function's definition line. */
  definitionLine: number;
  /** Callees by time, for functions whose own time is tiny. */
  callees: Array<{ fn: number | null; name: string; origin: number; us: number }>;
  chips: CallSiteChip[];
  /** The numbers of the selected call node, when a call (not a function) is selected. */
  call: CallNumbers | null;
  /** What the callee chips and callee list cover: every call of the function, or the selected call. */
  scopeMode: 'all' | 'call';
  /** Estimated calls of the function, 0 when unknown. */
  calls: number;
  /** "across all ~34 calls": what the line bars and totals cover. */
  acrossAll: string;
  reason: SourceReason | null;
  loading: boolean;
}

interface Options {
  /** Show the whole file instead of a window around the function. */
  whole: boolean;
  /** Which calls the callee chips cover; a function (no call) always means all. Default `all`. */
  mode?: 'all' | 'call';
}

/** The function's lines moved to where the formatter put them; time on a line goes to its first formatted line. */
function laidOut(info: SourceInfo, layout: FormattedSource): SourceInfo {
  const at = (line: number): number =>
    layout.lineOf(line, line === info.definitionLine ? info.definitionCol : 0);
  const self = new Map<number, number>();
  for (const l of info.lineSelf) self.set(at(l.line), (self.get(at(l.line)) ?? 0) + l.selfUs);
  return {
    ...info,
    startLine: at(info.startLine),
    definitionLine: at(info.definitionLine),
    hottestLine: info.hottestLine > 0 ? at(info.hottestLine) : 0,
    lineSelf: [...self].map(([line, selfUs]) => ({ line, selfUs })).sort((a, b) => a.line - b.line),
    deopts: info.deopts.map((d) => ({ ...d, line: d.line > 0 ? at(d.line) : d.line })),
  };
}

/** Everything the source dock and the Source view need for the selected function. */
export function useSource({ whole, mode = 'all' }: Options): SourceState {
  const { client, host, scope, scopeKey, snap, selection, summary } = useApp();
  const fn = selection.fn;
  const infoQ = useAsync(
    () => (fn === null ? Promise.resolve(null) : client.source(scope, fn)),
    `src:${scopeKey}:${fn}`,
  );
  const detailsQ = useAsync(
    () => (fn === null ? Promise.resolve(null) : client.details(scope, fn)),
    `src-details:${scopeKey}:${fn}`,
  );
  const nodePath = selection.path;
  const callKey = snap.selection.kind === 'node' && nodePath ? nodePath.join('.') : '';
  const callQ = useAsync(
    () => (callKey && nodePath ? client.callAt(scope, nodePath) : Promise.resolve(null)),
    `call:${scopeKey}:${callKey}`,
  );
  const call = callKey ? (callQ.data ?? null) : null;
  const scopeMode: 'all' | 'call' = mode === 'call' && call ? 'call' : 'all';
  const rawInfo = fn === null ? null : (infoQ.data ?? null);
  const details = fn === null ? null : (detailsQ.data ?? null);
  const path = rawInfo?.path ?? '';
  const textQ = useAsync(
    () => (path ? host.readSource(path) : Promise.resolve(null)),
    `text:${path}`,
  );
  const file = path && !textQ.loading ? (textQ.data ?? null) : null;

  const rawLines = useMemo(() => (file?.exists ? file.text.split(/\r?\n/) : []), [file]);
  const minified = file?.exists === true && looksMinified(rawLines);
  const layoutQ = useAsync(
    () => (minified && file ? formatMinified(file.text) : Promise.resolve(null)),
    `layout:${path}:${minified}:${file?.text.length ?? 0}`,
  );
  const layout = minified ? (layoutQ.data ?? null) : null;
  const allLines = layout ? layout.lines : rawLines;
  const info = useMemo(
    () => (rawInfo && layout ? laidOut(rawInfo, layout) : rawInfo),
    [rawInfo, layout],
  );
  const lines = useMemo((): SourceLine[] => {
    if (info && allLines.length > 0) {
      if (whole) return allLines.map((text, i) => ({ n: i + 1, text }));
      const win = lineWindow(allLines, info.startLine || 1, 3, 200);
      return Array.from({ length: win.last - win.first + 1 }, (_, k) => ({
        n: win.first + k,
        text: allLines[win.first + k - 1] ?? '',
      }));
    }
    // Without readable source, still list the lines that have time attributed to them.
    return (info?.lineSelf ?? []).map((l) => ({ n: l.line, text: '' }));
  }, [info, allLines, whole]);

  const definitionLine = info ? info.definitionLine || info.startLine : 0;
  // Time V8 reports inside a multi-line call lands on an arbitrary one of its lines; show it on the
  // statement's first line, and remember where V8 put it for the tooltip.
  const rolled = useMemo(
    () =>
      info && allLines.length > 0
        ? rollUpToStatements(allLines, info.lineSelf, definitionLine || 1)
        : (info?.lineSelf ?? []).map((l) => ({ line: l.line, selfUs: l.selfUs, from: [] })),
    [info, allLines, definitionLine],
  );
  const selfByLine = useMemo(() => new Map(rolled.map((r) => [r.line, r.selfUs])), [rolled]);
  const rolledFrom = useMemo(
    () => new Map(rolled.filter((r) => r.from.length > 0).map((r) => [r.line, r.from])),
    [rolled],
  );
  const deoptsByLine = useMemo(() => {
    const byLine = new Map<number, SourceInfo['deopts']>();
    for (const d of info?.deopts ?? []) {
      if (d.line > 0) byLine.set(d.line, [...(byLine.get(d.line) ?? []), d]);
    }
    return byLine;
  }, [info]);
  const maxSelf = Math.max(0, ...rolled.map((r) => r.selfUs));
  const hottest = rolled.reduce(
    (best, r) => (r.selfUs > (selfByLine.get(best) ?? 0) ? r.line : best),
    rolled[0]?.line ?? info?.hottestLine ?? 0,
  );
  // The highlight is always the definition; hot lines are only gutter bars. A jump moves the scroll.
  const targetLine = snap.options.line > 0 ? snap.options.line : definitionLine;
  // The callees the chips and the "where the time went" list cover: this call's, or all calls'.
  const inCall = scopeMode === 'call' && call ? call : null;
  const callees = (inCall?.callees ?? info?.calleeTime ?? []).map((c) => ({
    fn: c.fn,
    name: c.name,
    origin: c.origin,
    us: c.totalUs,
  }));

  const chips = useMemo(() => {
    if (!details || allLines.length === 0) return [];
    const shown = inCall
      ? inCall.callees.map((c) => ({
          fn: c.fn,
          name: c.name,
          totalUs: c.totalUs,
          origin: c.origin,
        }))
      : details.callees
          .filter((c) => c.kind === 'callee')
          .map((c) => ({
            fn: c.fn,
            name: c.name,
            totalUs: c.frac * details.totalUs,
            origin: c.origin,
          }));
    return matchCallSites(
      lines.map((l) => l.text),
      shown,
    );
  }, [allLines, details, lines, inCall]);

  const reason = info
    ? sourceReason({
        path,
        exists: file ? file.exists : undefined,
        error: textQ.error,
        hostDown: isHostLost(textQ.error),
        mapMissing: info.mapMissing,
        lineCount: info.lineSelf.length,
        selfUs: details?.selfUs,
        hasCallees: callees.length > 0,
        lineStatus: info.lineStatus,
        lineReason: info.lineReason,
      })
    : null;

  return {
    fn,
    info,
    details,
    lines,
    fileTexts: allLines,
    formatted: layout !== null,
    changed: file?.exists === true && file.changedSinceProfile,
    selfByLine,
    deoptsByLine,
    rolledFrom,
    precisionUs: summary.precisionUs,
    maxSelf,
    hottest,
    targetLine,
    definitionLine,
    callees,
    chips,
    call,
    scopeMode,
    calls: details?.calls ?? 0,
    acrossAll:
      details && details.calls > 0 ? TEXT.acrossAllCalls(fmtCount(details.calls)) : TEXT.acrossAll,
    reason,
    loading: infoQ.loading || (path !== '' && textQ.loading),
  };
}
