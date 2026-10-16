import { describe, expect, it } from 'vitest';
import { fmtAxis, fmtCount, fmtDuration, fmtRange, fmtShare } from '../../src/util/format';
import { isBelowPrecision, lowerBound, packBlocks, visibleRange } from '../../src/view/lod';
import { linearScale, niceStep, niceTicks } from '../../src/view/scale';
import { charBudget, fitLabel, midTruncate } from '../../src/view/truncate';

describe('scales', () => {
  it('maps a domain to a pixel range and back', () => {
    const s = linearScale([0, 200], [10, 110]);
    expect(s(100)).toBe(60);
    expect(s.invert(60)).toBe(100);
  });

  it.each([
    [182, 7, 20],
    [42.8, 9, 5],
    [1.6, 8, 0.2],
    [1000, 5, 200],
  ])('picks a nice step for span %d with %d ticks', (span, count, step) => {
    expect(niceStep(span, count)).toBeCloseTo(step);
  });

  it('produces ticks that are multiples of the step inside the window', () => {
    expect(niceTicks(0, 182, 8)).toEqual([0, 20, 40, 60, 80, 100, 120, 140, 160, 180]);
    expect(niceTicks(18, 19.6, 4)).toEqual([18, 18.5, 19, 19.5]);
  });
});

describe('units', () => {
  it('uses ms below 10 s and seconds above', () => {
    expect(fmtDuration(5_600)).toBe('~5.6 ms');
    expect(fmtDuration(182_000)).toBe('~182 ms');
    expect(fmtDuration(182_000, { decimals: 1 })).toBe('~182.0 ms');
    expect(fmtDuration(12_300_000)).toBe('~12.3 s');
  });

  it('drops the tilde for exact data', () => {
    expect(fmtDuration(5_600, { approx: false })).toBe('5.6 ms');
  });

  it('formats shares, counts, axis ticks and ranges', () => {
    expect(fmtShare(0.1842)).toBe('18.4%');
    expect(fmtCount(1340)).toBe('~1,340');
    expect(fmtAxis(25_000, 'ms', false)).toBe('25');
    expect(fmtAxis(0, 'ms', true)).toBe('0 ms');
    expect(fmtAxis(5_000_000, 's', true)).toBe('5 s');
    expect(fmtRange(18_000_000, 19_600_000)).toBe('18.0–19.6 s');
  });
});

describe('label truncation', () => {
  it('truncates in the middle and keeps both ends', () => {
    expect(midTruncate('buildInvoiceRowsFromOrder', 11)).toBe('build…Order');
  });

  it('returns nothing when there is no room', () => {
    expect(midTruncate('buildInvoiceRows', 4)).toBe('');
  });

  it('prefers name and location, then name, then nothing', () => {
    expect(fitLabel('loadTemplate', 'src/render/template.ts:38', 60)).toBe(
      'loadTemplate · src/render/template.ts:38',
    );
    expect(fitLabel('loadTemplate', 'src/render/template.ts:38', 8)).toBe('load…ate');
    expect(fitLabel('loadTemplate', 'src/render/template.ts:38', 3)).toBe('');
  });

  it('derives a character budget from pixels', () => {
    expect(charBudget(100, 16, 7)).toBe(12);
  });
});

describe('level of detail', () => {
  const px = (v: number) => v / 10;

  it('merges sub-pixel neighbours into one aggregate block', () => {
    const blocks = packBlocks([0, 2, 4, 6], [1, 3, 5, 7], px);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.count).toBe(4);
  });

  it('keeps wide blocks separate', () => {
    const blocks = packBlocks([0, 500], [300, 900], px);
    expect(blocks.map((b) => b.count)).toEqual([1, 1]);
  });

  it('finds the visible slice of sorted values', () => {
    const t = [0, 10, 20, 30, 40];
    expect(lowerBound(t, 20)).toBe(2);
    expect(visibleRange(t, 10, 30)).toEqual([1, 4]);
  });

  it('marks durations under two sampling intervals as below precision', () => {
    expect(isBelowPrecision(1_900, 1_000)).toBe(true);
    expect(isBelowPrecision(2_000, 1_000)).toBe(false);
  });
});
