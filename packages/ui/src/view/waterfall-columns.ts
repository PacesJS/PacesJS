import type { WaterfallRow } from '../data/types';
import { WF_COLUMN_LIMITS, clampColumns } from '../state/prefs';
import type { WfColumns } from '../state/prefs';

export type ColumnKey = keyof WfColumns;

/** Width of the bar column never drops below this, whatever the other columns ask for. */
export const MIN_BAR_PX = 160;

/** `grid-template-columns` shared by the header, the minimap row and every call row. */
export function gridTemplate(cols: WfColumns): string {
  return `${cols.call}px minmax(${MIN_BAR_PX}px, 1fr) ${cols.time}px ${cols.share}px`;
}

/**
 * Drag a column edge. CALL grows when its right edge moves right; TIME and SHARE sit to the
 * right of the bars, so their left edge moving right makes them narrower.
 */
export function resizeColumn(cols: WfColumns, key: ColumnKey, deltaPx: number): WfColumns {
  const next = { ...cols, [key]: cols[key] + (key === 'call' ? deltaPx : -deltaPx) };
  return clampColumns(next);
}

/** Space a call row needs beside its name: twisty, dot, gaps and the cell padding. */
const NAME_CHROME = 14 + 8 + 6 * 2 + 16;
const INDENT_PX = 16;
const LOC_FIT_PX = 140;

/** Width that fits the widest visible CALL cell (name, indent, and a share of the location). */
export function fitCallWidth(
  rows: readonly WaterfallRow[],
  measureName: (text: string) => number,
  measureLoc: (text: string) => number,
): number {
  let widest = 0;
  for (const r of rows) {
    const w =
      r.depth * INDENT_PX +
      NAME_CHROME +
      measureName(r.name) +
      (r.loc ? 8 + Math.min(measureLoc(r.loc), LOC_FIT_PX) : 0);
    widest = Math.max(widest, w);
  }
  return Math.round(clampColumns({ call: widest, time: 0, share: 0 }).call);
}

/** Width that fits the widest label of a numeric column. */
export function fitNumericWidth(
  key: 'time' | 'share',
  labels: readonly string[],
  measure: (text: string) => number,
): number {
  const widest = labels.reduce((m, l) => Math.max(m, measure(l)), 0);
  const limits = WF_COLUMN_LIMITS[key];
  return Math.round(Math.min(limits.max, Math.max(limits.min, widest + 16)));
}
