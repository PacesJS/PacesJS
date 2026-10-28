import { describe, expect, it } from 'vitest';
import type { BrowserVital } from '@pacesjs/engine';
import { clusterMilestones, clusterTip, milestoneTip, milestones } from '../../src/view/milestones';

const v = (
  name: BrowserVital['name'],
  timeUs: number,
  navigationUs = 0,
  value = 0,
): BrowserVital => ({
  name,
  timeUs,
  value,
  navigationUs,
});

describe('milestones', () => {
  it('names the four load milestones in words, in time order', () => {
    const out = milestones(
      [v('load', 3000), v('FCP', 900), v('LCP', 2000), v('DOMContentLoaded', 1100)],
      10_000,
    );
    expect(out.map((m) => m.label)).toEqual([
      'First contentful paint',
      'DOM ready',
      'Largest contentful paint',
      'Page loaded',
    ]);
  });

  it('keeps the largest paint of every page load, not only the last', () => {
    const out = milestones([v('LCP', 500, 0), v('LCP', 5000, 4000)], 10_000);
    expect(out.map((m) => m.timeUs)).toEqual([500, 5000]);
  });

  it('leaves out the navigation start and layout shifts, which have their own marks', () => {
    expect(milestones([v('navigation', 0), v('shift', 400, 0, 0.2)], 10_000)).toEqual([]);
  });

  it('gives each milestone its own color key', () => {
    const out = milestones(
      [v('FCP', 1), v('DOMContentLoaded', 2), v('LCP', 3), v('load', 4)],
      10_000,
    );
    expect(new Set(out.map((m) => m.kind)).size).toBe(4);
  });

  it('draws nothing for a run with no duration', () => {
    expect(milestones([v('FCP', 0)], 0)).toEqual([]);
  });
});

describe('milestoneTip', () => {
  it('says how long after its navigation a milestone came, and where it is in the recording', () => {
    const [m] = milestones([v('LCP', 26_940_000, 26_900_000)], 36_000_000);
    expect(m && milestoneTip(m)).toEqual({
      title: 'Largest contentful paint',
      lines: ['0.04 s after the page began loading', 'At 26.94 s of the recording'],
    });
  });

  it('says the time is unknown when the page began loading while recording was paused', () => {
    const [m] = milestones([v('LCP', 26_940_000, -1)], 36_000_000);
    expect(m && milestoneTip(m).lines).toEqual([
      'At 26.94 s of the recording',
      'Its page began loading while recording was paused, so how long it took is unknown',
    ]);
  });
});

describe('clusterMilestones', () => {
  it('groups milestones that would sit on top of each other and keeps the rest apart', () => {
    const marks = milestones(
      [
        v('FCP', 1_000_000),
        v('DOMContentLoaded', 1_010_000),
        v('LCP', 1_040_000),
        v('load', 8_000_000),
      ],
      10_000_000,
    );
    const groups = clusterMilestones(marks, 10_000_000, 1000);
    expect(groups.map((g) => g.map((m) => m.kind))).toEqual([
      ['FCP', 'DOMContentLoaded', 'LCP'],
      ['load'],
    ]);
  });

  it('draws nothing without a width', () => {
    expect(clusterMilestones(milestones([v('FCP', 1)], 10), 10, 0)).toEqual([]);
  });
});

describe('clusterTip', () => {
  it('lists every milestone of a group, each with its own time', () => {
    const marks = milestones(
      [v('FCP', 1_000_000, 900_000), v('LCP', 1_040_000, 900_000)],
      10_000_000,
    );
    expect(clusterTip(marks)).toEqual({
      title: 'Loading milestones',
      lines: [
        'First contentful paint: 0.10 s after the page began loading',
        'Largest contentful paint: 0.14 s after the page began loading',
      ],
    });
  });

  it('says the one milestone of a group as milestoneTip does', () => {
    const marks = milestones([v('load', 2_000_000, 0)], 10_000_000);
    expect(clusterTip(marks)).toEqual(milestoneTip(marks[0] as (typeof marks)[number]));
  });
});
