import { describe, expect, it } from 'vitest';
import { labelledMilestones } from '../../src/components/PageLane';

import type { BrowserVital } from '@pacesjs/engine';

const v = (name: BrowserVital['name'], timeUs: number): BrowserVital => ({
  name,
  timeUs,
  value: 0,
});

describe('which milestones carry a label', () => {
  it('labels FCP and load when they are far enough apart', () => {
    expect([...labelledMilestones([v('FCP', 100), v('load', 5000)], 10_000)]).toEqual([0, 1]);
  });

  it('skips a label that would sit on the one before', () => {
    expect([...labelledMilestones([v('FCP', 1000), v('load', 1100)], 10_000)]).toEqual([0]);
  });

  it('never labels the other marks', () => {
    expect(labelledMilestones([v('LCP', 100), v('navigation', 200)], 10_000).size).toBe(0);
  });
});
