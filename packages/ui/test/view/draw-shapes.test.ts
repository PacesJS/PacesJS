import { describe, expect, it } from 'vitest';
import { roundedRectPath } from '../../src/view/draw-shapes';

function calls(x: number, y: number, w: number, h: number, r: number): unknown[][] {
  const log: unknown[][] = [];
  const ctx = new Proxy(
    {},
    {
      get:
        (_t, name: string) =>
        (...a: unknown[]) =>
          log.push([name, ...a]),
    },
  ) as CanvasRenderingContext2D;
  roundedRectPath(ctx, x, y, w, h, r);
  return log;
}

describe('roundedRectPath', () => {
  it('traces four arcs from the top-left corner inwards', () => {
    expect(calls(10, 20, 100, 40, 4)).toEqual([
      ['beginPath'],
      ['moveTo', 14, 20],
      ['arcTo', 110, 20, 110, 60, 4],
      ['arcTo', 110, 60, 10, 60, 4],
      ['arcTo', 10, 60, 10, 20, 4],
      ['arcTo', 10, 20, 110, 20, 4],
      ['closePath'],
    ]);
  });

  it('shrinks the radius to half of the shorter side', () => {
    expect(calls(0, 0, 6, 20, 4)[1]).toEqual(['moveTo', 3, 0]);
  });
});
