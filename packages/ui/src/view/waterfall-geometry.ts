/** Layout constants shared with views.css (.wf-row grid: 320px | 1fr | 76px | 60px, gap 12px, pad 8px). */
export const WF = {
  rowH: 32,
  pad: 8,
  gap: 12,
  nameCol: 320,
  timeCol: 76,
  shareCol: 60,
  barTop: 6,
  barH: 20,
  minBarPx: 4,
} as const;

/** Left and right edge of the bar column inside a row container of the given width. */
export function barColumn(
  containerWidth: number,
  cols: { call: number; time: number; share: number } = {
    call: WF.nameCol,
    time: WF.timeCol,
    share: WF.shareCol,
  },
): { x0: number; x1: number } {
  const x0 = WF.pad + cols.call + WF.gap;
  const x1 = containerWidth - WF.pad - cols.share - WF.gap - cols.time - WF.gap;
  return { x0, x1: Math.max(x0 + 1, x1) };
}

export interface TimeWindow {
  /** Microseconds from the task start. */
  start: number;
  end: number;
}

export interface BarRect {
  x: number;
  w: number;
  /** Fully outside the visible window. */
  hidden: boolean;
}

/** Pixel rect of a bar for the visible time window; bars keep a minimum width. */
export function barRect(
  startUs: number,
  endUs: number,
  win: TimeWindow,
  x0: number,
  x1: number,
): BarRect {
  const span = win.end - win.start || 1;
  const px = (t: number): number => x0 + ((t - win.start) / span) * (x1 - x0);
  const a = px(startUs);
  const b = px(endUs);
  if (b < x0 || a > x1) return { x: a, w: 0, hidden: true };
  const left = Math.max(a, x0 - 1);
  const right = Math.min(b, x1 + 1);
  return { x: left, w: Math.max(WF.minBarPx, right - left), hidden: false };
}

/** Rows to render for a scroll position, with overscan; [start, end). */
export function visibleSlice(
  scrollTop: number,
  viewportH: number,
  count: number,
  overscan = 6,
): [number, number] {
  const first = Math.max(0, Math.floor(scrollTop / WF.rowH) - overscan);
  const last = Math.min(count, Math.ceil((scrollTop + viewportH) / WF.rowH) + overscan);
  return [first, Math.max(first, last)];
}

/** Zoom a window around an anchor fraction; clamped to [0, total]. */
export function zoomWindow(
  win: TimeWindow,
  total: number,
  anchor: number,
  factor: number,
): TimeWindow {
  const span = win.end - win.start;
  const next = Math.min(total, Math.max(total / 2000, span * factor));
  const center = win.start + span * anchor;
  let start = center - next * anchor;
  let end = start + next;
  if (start < 0) {
    end -= start;
    start = 0;
  }
  if (end > total) {
    start -= end - total;
    end = total;
  }
  return { start: Math.max(0, start), end };
}

export function panWindow(win: TimeWindow, total: number, deltaUs: number): TimeWindow {
  const span = win.end - win.start;
  const start = Math.min(total - span, Math.max(0, win.start + deltaUs));
  return { start, end: start + span };
}

/** Whether a duration label fits inside a bar of this width. */
export function labelFitsBar(widthPx: number, barColumnPx: number): boolean {
  return widthPx > 0.12 * barColumnPx && widthPx > 56;
}
