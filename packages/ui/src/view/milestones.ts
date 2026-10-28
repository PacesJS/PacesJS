import type { BrowserTimeline } from '@pacesjs/engine';
import { fmtSeconds } from '../util/format';

export type MilestoneKind = 'FCP' | 'DOMContentLoaded' | 'LCP' | 'load';

export interface Milestone {
  kind: MilestoneKind;
  label: string;
  timeUs: number;
  /** When the page load it belongs to began; -1 when that began while recording was paused. */
  navigationUs: number;
}

const LABELS: Record<MilestoneKind, string> = {
  FCP: 'First contentful paint',
  DOMContentLoaded: 'DOM ready',
  LCP: 'Largest contentful paint',
  load: 'Page loaded',
};

const KINDS = new Set<string>(Object.keys(LABELS));

/** The loading milestones that get a full-height line, in time order. */
export function milestones(vitals: BrowserTimeline['vitals'], durationUs: number): Milestone[] {
  if (durationUs <= 0) return [];
  return vitals
    .filter((v) => KINDS.has(v.name))
    .map((v) => {
      const kind = v.name as MilestoneKind;
      return { kind, label: LABELS[kind], timeUs: v.timeUs, navigationUs: v.navigationUs };
    })
    .sort((a, b) => a.timeUs - b.timeUs);
}

/** What a hovered milestone says: how long its page took to get there, and where that is in the run. */
export function milestoneTip(m: Milestone): { title: string; lines: string[] } {
  const at = `At ${fmtSeconds(m.timeUs, 2)} of the recording`;
  if (m.navigationUs < 0) {
    return {
      title: m.label,
      lines: [
        at,
        'Its page began loading while recording was paused, so how long it took is unknown',
      ],
    };
  }
  return {
    title: m.label,
    lines: [`${fmtSeconds(m.timeUs - m.navigationUs, 2)} after the page began loading`, at],
  };
}

/** Milestones closer than `gapPx` share one hover target, listed in time order. */
export function clusterMilestones(
  marks: readonly Milestone[],
  durationUs: number,
  widthPx: number,
  gapPx = 12,
): Milestone[][] {
  if (durationUs <= 0 || widthPx <= 0) return [];
  const gapUs = (gapPx * durationUs) / widthPx;
  const out: Milestone[][] = [];
  for (const m of marks) {
    const group = out[out.length - 1];
    const first = group?.[0];
    if (group && first && m.timeUs - first.timeUs < gapUs) group.push(m);
    else out.push([m]);
  }
  return out;
}

/** The tooltip of one or several milestones that share a hover target. */
export function clusterTip(group: readonly Milestone[]): { title: string; lines: string[] } {
  const [only] = group;
  if (group.length === 1 && only) return milestoneTip(only);
  return {
    title: 'Loading milestones',
    lines: group.map((m) =>
      m.navigationUs < 0
        ? `${m.label}: at ${fmtSeconds(m.timeUs, 2)}, its load time is unknown`
        : `${m.label}: ${fmtSeconds(m.timeUs - m.navigationUs, 2)} after the page began loading`,
    ),
  };
}
