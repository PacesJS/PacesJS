import { describe, expect, it } from 'vitest';
import {
  MAX_K,
  MIN_K,
  centerOn,
  detailAt,
  fitViewport,
  focusViewport,
  isInView,
  panBy,
  percent,
  zoomAt,
} from '../../src/view/graph-viewport';

const box = { w: 800, h: 500 };
const rect = { x: 1000, y: 600, w: 200, h: 72 };

describe('call graph zoom and pan', () => {
  it('keeps the point under the cursor fixed while zooming', () => {
    const v = { k: 1, x: 40, y: 20 };
    const before = { x: (300 - v.x) / v.k, y: (200 - v.y) / v.k };
    const z = zoomAt(v, 1.6, 300, 200);
    expect((300 - z.x) / z.k).toBeCloseTo(before.x, 9);
    expect((200 - z.y) / z.k).toBeCloseTo(before.y, 9);
    expect(z.k).toBeCloseTo(1.6, 9);
  });

  it('never zooms past the limits', () => {
    expect(zoomAt({ k: 1, x: 0, y: 0 }, 1e6, 0, 0).k).toBe(MAX_K);
    expect(zoomAt({ k: 1, x: 0, y: 0 }, 1e-9, 0, 0).k).toBe(MIN_K);
  });

  it('pans by a pixel offset without changing the scale', () => {
    expect(panBy({ k: 0.5, x: 10, y: 10 }, -4, 6)).toEqual({ k: 0.5, x: 6, y: 16 });
  });

  it('fits a large graph inside the box and centres it', () => {
    const v = fitViewport({ w: 3000, h: 1000 }, box);
    expect(v.k).toBeCloseTo((800 - 32) / 3000, 9);
    expect(v.x + 3000 * v.k).toBeCloseTo(box.w - v.x, 9);
    expect(v.y * 2 + 1000 * v.k).toBeCloseTo(box.h, 9);
  });

  it('does not enlarge a small graph beyond 100%', () => {
    expect(fitViewport({ w: 300, h: 100 }, box).k).toBe(1);
  });

  it('centres a node, keeping the scale', () => {
    const v = centerOn({ k: 0.5, x: 0, y: 0 }, rect, box);
    expect((rect.x + rect.w / 2) * 0.5 + v.x).toBeCloseTo(box.w / 2, 9);
    expect((rect.y + rect.h / 2) * 0.5 + v.y).toBeCloseTo(box.h / 2, 9);
    expect(v.k).toBe(0.5);
  });

  it('knows whether a node is inside the box', () => {
    expect(isInView({ k: 1, x: 0, y: 0 }, { x: 100, y: 100, w: 200, h: 72 }, box)).toBe(true);
    expect(isInView({ k: 1, x: 0, y: 0 }, rect, box)).toBe(false);
    expect(isInView({ k: 1, x: 0, y: 0 }, { x: 690, y: 100, w: 200, h: 72 }, box)).toBe(false);
  });

  it('opens on a selected node at a readable scale instead of the whole graph', () => {
    const v = focusViewport({ w: 6000, h: 2000 }, rect, box);
    expect(v.k).toBe(0.75);
    expect(isInView(v, rect, box)).toBe(true);
  });

  it('reduces detail as nodes shrink', () => {
    expect(detailAt(1)).toBe('full');
    expect(detailAt(0.4)).toBe('compact');
    expect(detailAt(0.1)).toBe('minimal');
  });

  it('shows the zoom as a percentage', () => {
    expect(percent(0.256)).toBe('26%');
    expect(percent(1)).toBe('100%');
  });
});
