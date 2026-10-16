import type { LaneData } from '../data/overview';
import { LONG_TASK_US } from '../data/overview';
import type { Palette } from '../theme/palette';
import { packBlocks } from './lod';
import { linearScale, niceTicks } from './scale';

export interface LaneDrawOptions {
  /** Index of the selected task, or -1. */
  selectedTask: number;
  hoverTask: number;
  /** Seconds between grid lines is derived from the ticks the axis uses. */
  tickUs: number[];
}

const TASK_TOP = 24;
const TASK_H = 18;

/** Time ticks (microseconds) shared by the axis labels and the lane grid. */
export function laneTicks(durationUs: number, target = 9): number[] {
  return niceTicks(0, durationUs / 1_000_000, target).map((s) => s * 1_000_000);
}

/** Index of the task under a time, with a pixel tolerance converted to time. */
export function taskAtTime(
  lane: Pick<LaneData, 'taskStart' | 'taskEnd'>,
  us: number,
  tolUs: number,
): number {
  let best = -1;
  let bestDur = Infinity;
  for (let i = 0; i < lane.taskStart.length; i++) {
    const s = (lane.taskStart[i] ?? 0) - tolUs;
    const e = (lane.taskEnd[i] ?? 0) + tolUs;
    if (us >= s && us <= e) {
      const d = (lane.taskEnd[i] ?? 0) - (lane.taskStart[i] ?? 0);
      if (d < bestDur) {
        best = i;
        bestDur = d;
      }
    }
  }
  return best;
}

export function drawLane(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  lane: LaneData,
  pal: Palette,
  opts: LaneDrawOptions,
): void {
  const x = linearScale([0, lane.durationUs], [0, w]);

  ctx.strokeStyle = pal.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const t of opts.tickUs) {
    const px = Math.round(x(t)) + 0.5;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
  }
  ctx.stroke();

  // CPU activity: filled area with a line on top.
  const bins = lane.cpu.length;
  const top = 2;
  const ch = 20;
  ctx.beginPath();
  ctx.moveTo(0, top + ch);
  for (let b = 0; b < bins; b++) {
    const act = Math.min(1, (lane.cpu[b] ?? 0) * 1.0 + 0.04);
    ctx.lineTo(((b + 0.5) / bins) * w, top + ch - act * (ch - 2));
  }
  ctx.lineTo(w, top + ch);
  ctx.closePath();
  ctx.fillStyle = pal.cpuFill;
  ctx.fill();
  ctx.beginPath();
  for (let b = 0; b < bins; b++) {
    const act = Math.min(1, (lane.cpu[b] ?? 0) + 0.04);
    const px = ((b + 0.5) / bins) * w;
    const py = top + ch - act * (ch - 2);
    if (b === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = pal.cpuLine;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Task blocks, merged below one pixel.
  const blocks = packBlocks(lane.taskStart, lane.taskEnd, x, 3);
  ctx.font = `600 11px ${pal.fontSans}`;
  ctx.textBaseline = 'middle';
  for (const b of blocks) {
    const origin = lane.taskOrigin[b.first] ?? 0;
    ctx.fillStyle = pal.originSolid[origin] ?? pal.accent;
    roundRect(ctx, b.x, TASK_TOP, b.w, TASK_H, 3);
    ctx.fill();
    if (b.count === 1) {
      const label = lane.taskLabels[b.first] ?? '';
      const short = labelFor(label, b.w - 12);
      if (short && b.w > 30) {
        ctx.fillStyle = pal.ink;
        ctx.fillText(short, b.x + 6, TASK_TOP + TASK_H / 2 + 0.5);
      }
    }
  }

  for (let i = 0; i < lane.taskStart.length; i++) {
    const dur = (lane.taskEnd[i] ?? 0) - (lane.taskStart[i] ?? 0);
    if (dur > LONG_TASK_US) {
      const px = x(lane.taskEnd[i] ?? 0);
      ctx.fillStyle = pal.sevMedium;
      ctx.strokeStyle = pal.outline;
      ctx.lineWidth = 1;
      ctx.fillRect(px - 3, 19, 7, 7);
      ctx.strokeRect(px - 2.5, 19.5, 6, 6);
    }
  }

  for (const i of [opts.hoverTask, opts.selectedTask]) {
    if (i < 0 || i >= lane.taskStart.length) continue;
    const px = x(lane.taskStart[i] ?? 0);
    const pw = Math.max(3, x(lane.taskEnd[i] ?? 0) - px);
    ctx.strokeStyle = pal.outline;
    ctx.lineWidth = 2;
    ctx.strokeRect(px - 1, TASK_TOP - 1, pw + 2, TASK_H + 2);
  }

  // GC pauses as thin ticks; pauses over 50 ms get a heavier mark.
  for (let i = 0; i < lane.gcTime.length; i++) {
    const px = x(lane.gcTime[i] ?? 0);
    const long = (lane.gcDuration[i] ?? 0) > LONG_TASK_US;
    ctx.fillStyle = long ? pal.gcLong : pal.gcTick;
    ctx.fillRect(px, long ? 45 : 47, long ? 4 : 2, long ? 16 : 12);
  }
}

function labelFor(label: string, maxPx: number): string {
  const chars = Math.floor(maxPx / 6.4);
  if (chars < 3) return '';
  return label.length <= chars ? label : `${label.slice(0, chars - 1)}…`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Loop-delay polyline (p99 per bin), scaled to the largest value. */
export function drawDelay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  lane: LaneData,
  pal: Palette,
): void {
  const max = Math.max(1, lane.peakDelayUs);
  ctx.beginPath();
  for (let b = 0; b < lane.delay.length; b++) {
    const px = ((b + 0.5) / lane.delay.length) * w;
    const py = h - 2 - ((lane.delay[b] ?? 0) / max) * (h - 6);
    if (b === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = pal.delayLine;
  ctx.lineWidth = 1.25;
  ctx.stroke();
}
