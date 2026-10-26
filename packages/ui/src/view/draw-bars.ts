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
  /** V8 threw away optimized code of this function: mark the bar. */
  deopted?: boolean;
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
  if (style.deopted) drawDeoptMark(ctx, pal, x, y, w, h);
}

/** Narrower bars have no room for the mark next to their label. */
export const DEOPT_MIN_BAR_WIDTH = 24;
/** Width a bar's label gives up to the mark. */
export const DEOPT_MARK_ROOM = 14;

/**
 * A small downward triangle at the right end of a bar: V8 threw away this function's optimized code.
 * It points down because the code dropped to a slower tier.
 */
export function drawDeoptMark(
  ctx: CanvasRenderingContext2D,
  pal: Palette,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  if (w < DEOPT_MIN_BAR_WIDTH) return;
  const size = Math.min(9, h - 6);
  if (size < 4) return;
  const right = x + w - 4;
  const top = y + (h - size * 0.85) / 2;
  ctx.beginPath();
  ctx.moveTo(right - size, top);
  ctx.lineTo(right, top);
  ctx.lineTo(right - size / 2, top + size * 0.85);
  ctx.closePath();
  ctx.fillStyle = pal.deopt;
  ctx.strokeStyle = pal.deoptEdge;
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();
}
