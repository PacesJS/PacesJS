import type { WaterfallRow } from '../data/types';
import { focusTransform } from '../state/focus';
import type { Transform } from '../state/types';
import { originInfo } from '../theme/origin';
import { barRect } from './waterfall-geometry';
import { BADGE_DEPTH, FOCUS_DEPTH, indentFor, middleEllipsis } from './waterfall-indent';
import { barDetails, rowLocation } from './waterfall-labels';

const TEXT = {
  depthBadge: (depth: number) => `⋯ ${depth}`,
  hiddenCallees: (count: number, fold: string) =>
    `${count} ${count === 1 ? 'callee' : 'callees'} under ${fold} hidden`,
  level: (level: number) => `level ${level}`,
} as const;

export interface RowModelContext {
  /** Width of the call column, in px. */
  callWidth: number;
  fontSans: string;
  measure(text: string, font: string): number;
  functionCount: number;
  /** The precision label, e.g. "2 ms". */
  threshold: string;
  /** What the fold rows call the cut-off. */
  foldLabel: string;
  /** The word for the whole the share is of in the tooltip: the run or one task. */
  whole: 'run' | 'task';
  /** The visible time window and the bar column, to place the hover target over the bar. */
  winStart: number;
  winEnd: number;
  barX0: number;
  barX1: number;
  /** Direct callees the minimum duration hides under this row, and its CPU time. */
  hiddenKids: number;
  cpuUs: number;
}

export interface RowModel {
  originLabel: string;
  isUser: boolean;
  where: string;
  indent: number;
  badged: boolean;
  depthBadge: string;
  focusAs: Transform | null;
  label: string;
  hiddenNote: string;
  nameTitle: string;
  details: string;
  /** Where the bar's hover target sits, or null when the row has none to show. */
  barBox: { x: number; w: number } | null;
}

/** Everything a waterfall row shows that is derived from the row and the layout, with no React in it. */
export function waterfallRowModel(r: WaterfallRow, c: RowModelContext): RowModel {
  const isUser = r.origin === 0;
  const where = rowLocation(r);
  const indent = indentFor(r.depth, c.callWidth);
  const badged = r.kind === 'call' && r.depth > BADGE_DEPTH;
  const depthBadge = TEXT.depthBadge(r.depth);
  const focusAs =
    r.kind === 'call' && r.depth > FOCUS_DEPTH
      ? focusTransform(r.path, r.fn, c.functionCount)
      : null;
  const nameFont = `${isUser ? 600 : 500} 14px ${c.fontSans}`;
  const room =
    c.callWidth -
    indent -
    (14 + 8 + 12) -
    (focusAs ? 44 + 6 : badged ? c.measure(depthBadge, `600 11px ${c.fontSans}`) + 8 + 6 : 0) -
    (r.resumed ? 22 : 0) -
    2;
  const label = middleEllipsis(r.name, Math.max(room, 24), (t) => c.measure(t, nameFont));
  const hiddenNote = c.hiddenKids > 0 ? TEXT.hiddenCallees(c.hiddenKids, c.foldLabel) : '';
  const nameTitle = [
    r.name,
    where,
    r.depth > BADGE_DEPTH ? TEXT.level(r.depth + 1) : '',
    hiddenNote,
  ]
    .filter(Boolean)
    .join(' · ');
  const details = barDetails(r, c.threshold, c.whole, { cpuUs: c.cpuUs });
  const rect = barRect(r.start, r.end, { start: c.winStart, end: c.winEnd }, c.barX0, c.barX1);
  return {
    originLabel: originInfo(r.origin).label,
    isUser,
    where,
    indent,
    badged,
    depthBadge,
    focusAs,
    label,
    hiddenNote,
    nameTitle,
    details,
    barBox: details && !rect.hidden ? { x: rect.x, w: rect.w } : null,
  };
}
