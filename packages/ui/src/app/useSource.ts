import { useMemo } from 'react';
import { useApp } from './context';
import { useAsync } from './hooks';
import type { Details, SourceInfo } from '../data/types';
import { matchCallSites } from '../view/call-sites';
import type { CallSiteChip } from '../view/call-sites';
import { lineWindow } from '../view/source-lines';
import { sourceReason } from '../view/source-reason';
import type { SourceReason } from '../view/source-reason';

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
  /** The file changed on disk since the session was recorded. */
  changed: boolean;
  selfByLine: Map<number, number>;
  maxSelf: number;
  hottest: number;
  hotLine: number;
  chips: CallSiteChip[];
  reason: SourceReason | null;
  loading: boolean;
}

interface Options {
  /** Show the whole file instead of a window around the function. */
  whole: boolean;
}

/** Everything the source dock and the Source view need for the selected function. */
export function useSource({ whole }: Options): SourceState {
  const { client, host, scope, scopeKey, snap, selection } = useApp();
  const fn = selection.fn;
  const infoQ = useAsync(
    () => (fn === null ? Promise.resolve(null) : client.source(scope, fn)),
    `src:${scopeKey}:${fn}`,
  );
  const detailsQ = useAsync(
    () => (fn === null ? Promise.resolve(null) : client.details(scope, fn)),
    `src-details:${scopeKey}:${fn}`,
  );
  const info = fn === null ? null : (infoQ.data ?? null);
  const details = fn === null ? null : (detailsQ.data ?? null);
  const path = info?.path ?? '';
  const textQ = useAsync(
    () => (path ? host.readSource(path) : Promise.resolve(null)),
    `text:${path}`,
  );
  const file = path && !textQ.loading ? (textQ.data ?? null) : null;

  const allLines = useMemo(() => (file?.exists ? file.text.split(/\r?\n/) : []), [file]);
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

  const selfByLine = useMemo(
    () => new Map((info?.lineSelf ?? []).map((l) => [l.line, l.selfUs])),
    [info],
  );
  const maxSelf = Math.max(0, ...(info?.lineSelf ?? []).map((l) => l.selfUs));
  const hottest = info?.hottestLine ?? 0;
  const hotLine = snap.options.line > 0 ? snap.options.line : hottest;

  const chips = useMemo(() => {
    if (!details || allLines.length === 0) return [];
    const callees = details.callees
      .filter((c) => c.kind === 'callee')
      .map((c) => ({
        fn: c.fn,
        name: c.name,
        totalUs: c.frac * details.totalUs,
        origin: c.origin,
      }));
    return matchCallSites(
      lines.map((l) => l.text),
      callees,
    );
  }, [allLines, details, lines]);

  const reason = info
    ? sourceReason({
        path,
        exists: file ? file.exists : undefined,
        error: textQ.error,
        mapMissing: info.mapMissing,
        lineCount: info.lineSelf.length,
      })
    : null;

  return {
    fn,
    info,
    details,
    lines,
    fileTexts: allLines,
    changed: file?.exists === true && file.changedSinceProfile,
    selfByLine,
    maxSelf,
    hottest,
    hotLine,
    chips,
    reason,
    loading: infoQ.loading || (path !== '' && textQ.loading),
  };
}
