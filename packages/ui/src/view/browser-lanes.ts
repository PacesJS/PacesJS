// Geometry and level of detail for the browser lanes. Pure functions of the data and the width in
// pixels, so the components stay thin and the maths is tested without a DOM.

import type { BrowserInput, BrowserRender } from '@pacesjs/engine';

export interface RenderBlock {
  /** Left edge and width as a share of the run (0..1). */
  left: number;
  width: number;
  phase: BrowserRender['phase'];
  forced: boolean;
  /** How many rows were merged into this block. */
  count: number;
}

/**
 * Rendering rows as drawable blocks: never narrower than a pixel, and neighbours of the same phase
 * that would touch are merged, so a page with thousands of layouts draws a few hundred blocks.
 */
export function lodRender(
  rows: readonly BrowserRender[],
  durationUs: number,
  widthPx: number,
): RenderBlock[] {
  if (durationUs <= 0 || widthPx <= 0) return [];
  const pixel = 1 / widthPx;
  const sorted = [...rows].sort((a, b) => a.startUs - b.startUs);
  const out: RenderBlock[] = [];
  for (const row of sorted) {
    const left = row.startUs / durationUs;
    const width = Math.max(row.durUs / durationUs, pixel);
    const last = out[out.length - 1];
    if (
      last &&
      last.phase === row.phase &&
      last.forced === row.forced &&
      left - (last.left + last.width) < pixel
    ) {
      last.width = Math.max(last.left + last.width, left + width) - last.left;
      last.count++;
    } else out.push({ left, width, phase: row.phase, forced: row.forced, count: 1 });
  }
  return out;
}

export interface InputCluster {
  startUs: number;
  endUs: number;
  kind: BrowserInput['kind'];
  label: string;
  count: number;
  /** The longest delay to a paint among them, -1 when none applies. */
  slowestUs: number;
  /** Task of the first input, -1 = none. */
  task: number;
}

const PLURAL: Record<BrowserInput['kind'], string> = {
  click: 'clicks',
  submit: 'submits',
  change: 'changes',
  key: 'keys',
  typing: 'typing bursts',
  scroll: 'scrolls',
  navigate: 'navigations',
  visibility: 'visibility changes',
  more: 'more',
};

/** Inputs of one kind that sit closer than `minGapPx` become one block that says how many. */
export function clusterInputs(
  inputs: readonly BrowserInput[],
  durationUs: number,
  widthPx: number,
  minGapPx = 12,
): InputCluster[] {
  if (durationUs <= 0 || widthPx <= 0) return [];
  const gapUs = (minGapPx * durationUs) / widthPx;
  const sorted = [...inputs].sort((a, b) => a.startUs - b.startUs);
  const open = new Map<string, InputCluster & { lastStart: number }>();
  const out: Array<InputCluster & { lastStart: number }> = [];
  for (const input of sorted) {
    const current = open.get(input.kind);
    if (current && input.startUs - current.lastStart < gapUs) {
      current.count++;
      current.lastStart = input.startUs;
      current.endUs = Math.max(current.endUs, input.endUs);
      current.slowestUs = Math.max(current.slowestUs, input.latencyUs);
      current.label = `${current.count} ${PLURAL[input.kind]}`;
      continue;
    }
    const cluster = {
      startUs: input.startUs,
      endUs: input.endUs,
      kind: input.kind,
      label: input.label,
      count: 1,
      slowestUs: input.latencyUs,
      task: input.task,
      lastStart: input.startUs,
    };
    open.set(input.kind, cluster);
    out.push(cluster);
  }
  return out.map((c) => ({
    startUs: c.startUs,
    endUs: c.endUs,
    kind: c.kind,
    label: c.label,
    count: c.count,
    slowestUs: c.slowestUs,
    task: c.task,
  }));
}

export interface FilmstripSlot {
  /** Middle of the slot's share of the run. */
  timeUs: number;
  /** Frame id to show, null when there is none. */
  frame: number | null;
  /** Why there is no frame: a pause (nothing was recorded) or no frame close enough. */
  reason: 'frame' | 'paused' | 'none';
}

/**
 * What each slot of the strip shows: the last frame taken at or before it. A slot inside a pause, or
 * far from any frame, says so instead of showing nothing.
 */
export function filmstripSlots(
  shots: { time: Float64Array; id: Uint32Array },
  paused: ReadonlyArray<{ startUs: number; endUs: number }>,
  durationUs: number,
  slots: number,
): FilmstripSlot[] {
  const out: FilmstripSlot[] = [];
  for (let i = 0; i < slots; i++) {
    const timeUs = ((i + 0.5) * durationUs) / slots;
    if (paused.some((p) => timeUs >= p.startUs && timeUs <= p.endUs)) {
      out.push({ timeUs, frame: null, reason: 'paused' });
      continue;
    }
    let at = -1;
    for (let k = 0; k < shots.time.length; k++) if ((shots.time[k] ?? 0) <= timeUs) at = k;
    // The screencast only emits when the page changes, so the last frame stays true until the next one.
    const stale = at < 0;
    out.push(
      stale
        ? { timeUs, frame: null, reason: 'none' }
        : { timeUs, frame: shots.id[at] ?? null, reason: 'frame' },
    );
  }
  return out;
}

export function frameLabel(timeUs: number): string {
  return `Frame at ${(timeUs / 1e6).toFixed(2)} s`;
}
