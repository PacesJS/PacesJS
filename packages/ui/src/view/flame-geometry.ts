import type { FlameData } from '../data/types';
import type { FlameLayout } from '../state/types';
import { charBudget, fitLabel } from './truncate';

export const FLAME = {
  rowH: 30,
  frameH: 28,
  gap: 2,
  minPx: 0.6,
  glyph: 7.2,
  pad: 16,
  minHeight: 300,
} as const;

export interface FlameRect {
  /** Index into the FlameData columns. */
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Text that fits, or ''. */
  label: string;
}

/** Height for the rows that are wide enough to draw: deep slivers do not stretch the plot. */
export function flameHeight(data: FlameData, width: number): number {
  let deepest = 0;
  for (let i = 0; i < data.length; i++) {
    if ((data.w[i] ?? 0) * width - FLAME.gap >= FLAME.minPx)
      deepest = Math.max(deepest, data.depth[i] ?? 0);
  }
  return Math.max(FLAME.minHeight, (deepest + 1) * FLAME.rowH);
}

/** Pixel rects for every frame wide enough to draw. Sub-pixel frames are left out (level of detail). */
export function flameRects(
  data: FlameData,
  width: number,
  layout: FlameLayout,
  labelOf: (index: number) => { name: string; loc: string },
): FlameRect[] {
  const out: FlameRect[] = [];
  const height = flameHeight(data, width);
  for (let i = 0; i < data.length; i++) {
    const w = (data.w[i] ?? 0) * width - FLAME.gap;
    if (w < FLAME.minPx) continue;
    const depth = data.depth[i] ?? 0;
    const y =
      layout === 'icicle'
        ? depth * FLAME.rowH
        : height - (depth + 1) * FLAME.rowH + (FLAME.rowH - FLAME.frameH);
    const budget = charBudget(w, FLAME.pad, FLAME.glyph);
    let label = '';
    if (budget >= 5) {
      const { name, loc } = labelOf(i);
      label = fitLabel(name, loc, budget);
    }
    out.push({ index: i, x: (data.x[i] ?? 0) * width, y, w, h: FLAME.frameH, label });
  }
  return out;
}

/** Frame under a point, preferring the deepest rect (they never overlap within a row). */
export function hitRect(rects: readonly FlameRect[], x: number, y: number): FlameRect | null {
  for (let k = rects.length - 1; k >= 0; k--) {
    const r = rects[k] as FlameRect;
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
  }
  return null;
}
