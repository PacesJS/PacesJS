import type { BrowserTimeline } from '@pacesjs/engine';

export type MilestoneKind = 'FCP' | 'DOMContentLoaded' | 'LCP' | 'load';

export interface Milestone {
  kind: MilestoneKind;
  label: string;
  timeUs: number;
  /** Labels sit in rows, one per milestone, so none covers another. */
  row: number;
  /** The label hangs to the left of its line, so it stays inside the lane near the right edge. */
  flip: boolean;
}

const LABELS: Record<MilestoneKind, string> = {
  FCP: 'First contentful paint',
  DOMContentLoaded: 'DOM ready',
  LCP: 'Largest contentful paint',
  load: 'Page loaded',
};

/** A label this far along the run is put to the left of its line. */
const FLIP_AFTER = 0.8;

/** The loading milestones that get a full-height line: named in words, in time order, one row each. */
export function milestones(vitals: BrowserTimeline['vitals'], durationUs: number): Milestone[] {
  if (durationUs <= 0) return [];
  const found: Array<{ kind: MilestoneKind; timeUs: number }> = [];
  let lastLcp: number | undefined;
  for (const v of vitals) {
    if (v.name === 'LCP') lastLcp = Math.max(lastLcp ?? Number.NEGATIVE_INFINITY, v.timeUs);
    else if (v.name === 'FCP' || v.name === 'DOMContentLoaded' || v.name === 'load') {
      found.push({ kind: v.name, timeUs: v.timeUs });
    }
  }
  if (lastLcp !== undefined) found.push({ kind: 'LCP', timeUs: lastLcp });
  return found
    .sort((a, b) => a.timeUs - b.timeUs)
    .map((m, row) => ({
      ...m,
      label: LABELS[m.kind],
      row,
      flip: m.timeUs / durationUs > FLIP_AFTER,
    }));
}
