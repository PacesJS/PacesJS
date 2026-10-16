import { describe, expect, it } from 'vitest';
import {
  WF,
  barColumn,
  barRect,
  labelFitsBar,
  panWindow,
  visibleSlice,
  zoomWindow,
} from '../../src/view/waterfall-geometry';

describe('waterfall geometry', () => {
  it('places the bar column between the name column and the time and share columns', () => {
    expect(barColumn(1000)).toEqual({ x0: 340, x1: 832 });
  });

  it('scales a bar to the visible window', () => {
    const r = barRect(0, 91, { start: 0, end: 182 }, 0, 100);
    expect(r.x).toBe(0);
    expect(r.w).toBe(50);
  });

  it('keeps a minimum width so tiny bars stay visible', () => {
    expect(barRect(10, 10.01, { start: 0, end: 182 }, 0, 100).w).toBe(WF.minBarPx);
  });

  it('hides bars outside the window', () => {
    expect(barRect(150, 160, { start: 0, end: 100 }, 0, 100).hidden).toBe(true);
  });

  it('renders only the rows near the viewport', () => {
    expect(visibleSlice(0, 320, 1000, 0)).toEqual([0, 10]);
    expect(visibleSlice(3200, 320, 1000, 2)).toEqual([98, 112]);
  });

  it('zooms around the pointer and clamps to the task', () => {
    const w = zoomWindow({ start: 0, end: 100 }, 100, 0.5, 0.5);
    expect(w).toEqual({ start: 25, end: 75 });
    expect(zoomWindow({ start: 25, end: 75 }, 100, 0.5, 4)).toEqual({ start: 0, end: 100 });
  });

  it('pans without leaving the task', () => {
    expect(panWindow({ start: 10, end: 60 }, 100, 80)).toEqual({ start: 50, end: 100 });
    expect(panWindow({ start: 10, end: 60 }, 100, -80)).toEqual({ start: 0, end: 50 });
  });

  it('shows the duration inside only wide bars', () => {
    expect(labelFitsBar(200, 500)).toBe(true);
    expect(labelFitsBar(40, 500)).toBe(false);
  });
});
