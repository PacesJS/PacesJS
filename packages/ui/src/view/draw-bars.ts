import type { Palette } from '../theme/palette';
import { roundedRectPath } from './draw-shapes';
import { selfWidth } from './self-share';

/** Diagonal stripes inside a rect: "below measurement precision". */
export function hatch(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let d = -h; d < w + h; d += 5) {
    ctx.moveTo(x + d, y + h);
    ctx.lineTo(x + d + h, y);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * The call's own time, as white stripes over the left part of its bar, the full height of the bar and
 * clipped to its rounded shape. The origin color shows between the stripes.
 */
export function drawSelf(
  ctx: CanvasRenderingContext2D,
  pal: Palette,
  x: number,
  y: number,
  barW: number,
  barH: number,
  selfUs: number,
  totalUs: number,
): void {
  const w = selfWidth(barW, selfUs, totalUs);
  if (w <= 0) return;
  ctx.save();
  roundedRectPath(ctx, x, y, barW, barH, 4);
  ctx.clip();
  hatch(ctx, x, y, w, barH, pal.selfStripe);
  ctx.restore();
}

export interface BarStyle {
  origin: number;
  hatched: boolean;
  critical: boolean;
  /** Own and total time of the call; the own share is striped before the outline is drawn over it. */
  own?: { selfUs: number; totalUs: number };
}

/** One bar: dim fill for non-user origins, stripes under the sampling precision, outline for critical. */
export function drawBar(
  ctx: CanvasRenderingContext2D,
  pal: Palette,
  x: number,
  y: number,
  w: number,
  h: number,
  style: BarStyle,
): void {
  const solid = pal.originSolid[style.origin] ?? pal.accent;
  const dim = style.origin === 0 ? solid : (pal.originDim[style.origin] ?? solid);
  if (style.hatched) {
    hatch(ctx, x, y, w, h, solid);
  } else {
    ctx.fillStyle = dim;
    roundedRectPath(ctx, x, y, w, h, 4);
    ctx.fill();
    if (style.own) drawSelf(ctx, pal, x, y, w, h, style.own.selfUs, style.own.totalUs);
  }
  if (style.critical) {
    ctx.strokeStyle = pal.outline;
    ctx.lineWidth = 2;
    roundedRectPath(ctx, x + 1, y + 1, Math.max(1, w - 2), h - 2, 3);
    ctx.stroke();
  }
}
