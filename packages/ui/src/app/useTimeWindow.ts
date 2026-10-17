import { useMemo, useState } from 'react';
import type { PointerEvent, WheelEvent } from 'react';
import type { WfColumns } from '../state/prefs';
import { clamp } from '../view/scale';
import { barColumn, panWindow, zoomWindow } from '../view/waterfall-geometry';
import type { TimeWindow } from '../view/waterfall-geometry';

/**
 * The visible slice of a task's time axis: Ctrl + wheel zooms around the pointer, Shift + drag pans,
 * and a new task (a new `taskKey`) starts again at the whole task.
 */
export function useTimeWindow(o: {
  taskKey: string;
  taskUs: number;
  rowsEl: HTMLElement | null;
  cols: WfColumns;
}): {
  window: TimeWindow;
  reset(): void;
  onWheel(e: WheelEvent<HTMLElement>): void;
  onPanStart(e: PointerEvent<HTMLElement>): void;
} {
  const { taskKey, taskUs, rowsEl, cols } = o;
  const [win, setWin] = useState<{ key: string; w: TimeWindow } | null>(null);
  const window = useMemo(
    () => (win && win.key === taskKey ? win.w : { start: 0, end: taskUs }),
    [win, taskKey, taskUs],
  );

  const onWheel = (e: WheelEvent<HTMLElement>): void => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const rect = rowsEl?.getBoundingClientRect();
    if (!rect) return;
    const col = barColumn(rect.width, cols);
    const anchor = clamp((e.clientX - rect.left - col.x0) / (col.x1 - col.x0), 0, 1);
    setWin({ key: taskKey, w: zoomWindow(window, taskUs, anchor, e.deltaY > 0 ? 1.25 : 0.8) });
  };

  const onPanStart = (e: PointerEvent<HTMLElement>): void => {
    if (e.button !== 0 || !e.shiftKey) return;
    const start = e.clientX;
    const w0 = window;
    const rect = rowsEl?.getBoundingClientRect();
    if (!rect) return;
    const col = barColumn(rect.width, cols);
    const usPerPx = (w0.end - w0.start) / (col.x1 - col.x0);
    const onMove = (ev: globalThis.PointerEvent): void =>
      setWin({ key: taskKey, w: panWindow(w0, taskUs, -(ev.clientX - start) * usPerPx) });
    const onUp = (): void => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  return { window, reset: () => setWin(null), onWheel, onPanStart };
}
