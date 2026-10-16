// Pan and zoom math for the call graph. The graph is drawn once at layout size inside a
// translated and scaled layer; everything here maps between layout space and the viewport box.

export interface Viewport {
  /** Scale: 1 is 100%. */
  k: number;
  /** Screen offset of the layout origin, in pixels. */
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

export const MIN_K = 0.05;
export const MAX_K = 3;
export const ZOOM_STEP = 1.25;

export const clampK = (k: number): number => Math.min(MAX_K, Math.max(MIN_K, k));

/** Zoom by `factor` keeping the layout point under the screen point (cx, cy) where it is. */
export function zoomAt(v: Viewport, factor: number, cx: number, cy: number): Viewport {
  const k = clampK(v.k * factor);
  const f = k / v.k;
  return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
}

export const panBy = (v: Viewport, dx: number, dy: number): Viewport => ({
  ...v,
  x: v.x + dx,
  y: v.y + dy,
});

/** Scale the whole graph into the box and centre it. Never enlarges past `maxK`. */
export function fitViewport(content: Size, box: Size, margin = 16, maxK = 1): Viewport {
  const k = clampK(
    Math.min(
      maxK,
      (box.w - margin * 2) / Math.max(1, content.w),
      (box.h - margin * 2) / Math.max(1, content.h),
    ),
  );
  return { k, x: (box.w - content.w * k) / 2, y: (box.h - content.h * k) / 2 };
}

/** Pan (keeping the scale) so the layout rect sits in the middle of the box. */
export function centerOn(v: Viewport, rect: Rect, box: Size): Viewport {
  return {
    k: v.k,
    x: box.w / 2 - (rect.x + rect.w / 2) * v.k,
    y: box.h / 2 - (rect.y + rect.h / 2) * v.k,
  };
}

/** Whether the layout rect is fully inside the box, with a margin. */
export function isInView(v: Viewport, rect: Rect, box: Size, margin = 24): boolean {
  const left = rect.x * v.k + v.x;
  const top = rect.y * v.k + v.y;
  return (
    left >= margin &&
    top >= margin &&
    left + rect.w * v.k <= box.w - margin &&
    top + rect.h * v.k <= box.h - margin
  );
}

/** Zoom to a comfortable reading scale centred on a rect: at least `minK`, at most 1. */
export function focusViewport(content: Size, rect: Rect, box: Size, minK = 0.75): Viewport {
  const fit = fitViewport(content, box);
  return centerOn({ ...fit, k: Math.min(1, Math.max(fit.k, minK)) }, rect, box);
}

export type Detail = 'full' | 'compact' | 'minimal';

/** Level of detail: secondary text goes first when nodes get small, then the stats. */
export function detailAt(k: number): Detail {
  if (k >= 0.55) return 'full';
  if (k >= 0.28) return 'compact';
  return 'minimal';
}

export const percent = (k: number): string => `${Math.round(k * 100)}%`;
