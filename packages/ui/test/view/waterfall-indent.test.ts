import { describe, expect, it } from 'vitest';
import {
  FULL_STEP_PX,
  indentFor,
  guideLevels,
  middleEllipsis,
} from '../../src/view/waterfall-indent';

describe('indent of a deep row', () => {
  it('uses full steps for the first levels', () => {
    expect(indentFor(0, 640)).toBe(0);
    expect(indentFor(3, 640)).toBe(3 * FULL_STEP_PX);
    expect(indentFor(6, 640)).toBe(6 * FULL_STEP_PX);
  });

  it('squeezes the steps after the sixth level and again after the sixteenth', () => {
    const early = indentFor(7, 2000) - indentFor(6, 2000);
    const mid = indentFor(17, 2000) - indentFor(16, 2000);
    expect(early).toBeLessThan(FULL_STEP_PX);
    expect(mid).toBeLessThan(early);
  });

  it('never decreases with depth and never goes negative', () => {
    let last = 0;
    for (let d = -3; d < 400; d++) {
      const px = indentFor(d, 320);
      expect(px).toBeGreaterThanOrEqual(0);
      expect(px).toBeGreaterThanOrEqual(last);
      last = px;
    }
  });

  it('is capped at half the column', () => {
    expect(indentFor(500, 320)).toBeLessThanOrEqual(160);
    expect(indentFor(500, 640)).toBeLessThanOrEqual(320);
    expect(indentFor(500, 0)).toBe(0);
  });

  it('draws guide lines for the first levels only', () => {
    expect(guideLevels(2)).toBe(2);
    expect(guideLevels(180)).toBe(6);
  });
});

describe('middle ellipsis', () => {
  const measure = (s: string): number => s.length * 8;

  it('leaves a name that fits alone', () => {
    expect(middleEllipsis('lintFiles', 100, measure)).toBe('lintFiles');
  });

  it('keeps both ends of one that does not', () => {
    const cut = middleEllipsis('_verifyWithFlatConfigArrayAndWithoutProcessors', 120, measure);
    expect(cut).toContain('…');
    expect(cut.startsWith('_ver')).toBe(true);
    expect(cut.endsWith('ors')).toBe(true);
    expect(measure(cut)).toBeLessThanOrEqual(120);
  });

  it('returns at least an ellipsis however little room there is', () => {
    expect(middleEllipsis('abcdef', 1, measure)).toBe('…');
  });
});
