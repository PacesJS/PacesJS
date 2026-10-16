import { describe, expect, it } from 'vitest';
import { flameData } from '../../src/data/flame';
import { buildTView } from '../../src/data/tview';
import { DEFAULT_TRANSFORMS } from '../../src/state/types';
import { FLAME, flameRects, hitRect } from '../../src/view/flame-geometry';
import { ORDERS, buildModel } from '../helpers/model-builder';

const model = buildModel({ roots: ORDERS });
const tv = buildTView({ model, tracks: model.tracks, transforms: DEFAULT_TRANSFORMS, range: null });
const data = flameData(model, tv, { sort: 'heavy', color: 'origin', zoom: [] });
const labelOf = (): { name: string; loc: string } => ({
  name: 'getOrders',
  loc: 'src/routes/orders.ts:18',
});

describe('flame geometry', () => {
  it('lays the root across the full width and rows by depth, icicle style', () => {
    const rects = flameRects(data, 1000, 'icicle', labelOf);
    expect(rects[0]).toMatchObject({ x: 0, y: 0, h: FLAME.frameH });
    expect(rects[0]?.w).toBe(1000 - FLAME.gap);
    const deeper = rects.find((r) => data.depth[r.index] === 2);
    expect(deeper?.y).toBe(2 * FLAME.rowH);
  });

  it('flips the rows for classic upward flames', () => {
    const icicle = flameRects(data, 1000, 'icicle', labelOf);
    const flames = flameRects(data, 1000, 'flames', labelOf);
    expect((flames[0]?.y ?? 0) > (icicle[0]?.y ?? 0)).toBe(true);
  });

  it('drops frames narrower than a pixel and blanks labels that do not fit', () => {
    const rects = flameRects(data, 40, 'icicle', labelOf);
    expect(rects.length).toBeLessThan(data.length);
    expect(rects.every((r) => r.w >= FLAME.minPx)).toBe(true);
  });

  it('finds the frame under a point', () => {
    const rects = flameRects(data, 1000, 'icicle', labelOf);
    expect(hitRect(rects, 5, 5)?.index).toBe(0);
    expect(hitRect(rects, 5, 5000)).toBeNull();
  });

  it('shows name and location when they fit, name only when tight', () => {
    const rects = flameRects(data, 100000, 'icicle', labelOf);
    expect(rects[0]?.label).toBe('getOrders · src/routes/orders.ts:18');
  });
});
