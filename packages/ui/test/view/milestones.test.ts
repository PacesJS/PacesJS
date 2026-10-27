import { describe, expect, it } from 'vitest';
import type { BrowserVital } from '@pacesjs/engine';
import { milestones } from '../../src/view/milestones';

const v = (name: BrowserVital['name'], timeUs: number, value = 0): BrowserVital => ({
  name,
  timeUs,
  value,
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

  it('gives each milestone its own label row, so no two labels share a line', () => {
    const out = milestones([v('FCP', 100), v('DOMContentLoaded', 120), v('load', 130)], 10_000);
    expect(out.map((m) => m.row)).toEqual([0, 1, 2]);
  });

  it('keeps only the last largest-paint candidate, the one that counts', () => {
    const out = milestones([v('LCP', 500, 10), v('LCP', 1500, 90), v('LCP', 900, 40)], 10_000);
    expect(out.map((m) => m.timeUs)).toEqual([1500]);
  });

  it('leaves out the navigation start and layout shifts, which have their own marks', () => {
    expect(milestones([v('navigation', 0), v('shift', 400, 0.2)], 10_000)).toEqual([]);
  });

  it('flips a label near the right edge so it stays inside the lane', () => {
    const out = milestones([v('FCP', 1000), v('load', 9000)], 10_000);
    expect(out.map((m) => m.flip)).toEqual([false, true]);
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
