import { describe, expect, it } from 'vitest';
import { DEOPT_MIN_BAR_WIDTH, drawDeoptMark } from '../../src/view/draw-bars';
import type { Palette } from '../../src/theme/palette';

const pal = { deopt: 'navy', deoptEdge: 'white' } as Palette;

function draw(x: number, w: number): unknown[][] {
  const log: unknown[][] = [];
  const ctx = new Proxy(
    {},
    {
      get:
        (_t, name: string) =>
        (...a: unknown[]) =>
          log.push([name, ...a]),
      set: (_t, name: string, value: unknown) => {
        log.push([`set ${name}`, value]);
        return true;
      },
    },
  ) as CanvasRenderingContext2D;
  drawDeoptMark(ctx, pal, x, 10, w, 20);
  return log;
}

describe('drawDeoptMark', () => {
  it('draws nothing on a bar too narrow to hold it', () => {
    expect(draw(0, DEOPT_MIN_BAR_WIDTH - 1)).toEqual([]);
  });

  it('draws a filled triangle with an edge inside the right end of the bar', () => {
    const log = draw(100, 80);
    const points = log.filter(([n]) => n === 'moveTo' || n === 'lineTo') as number[][];
    expect(points).toHaveLength(3);
    for (const p of points) {
      expect(p[1]).toBeGreaterThan(100 + 80 / 2);
      expect(p[1]).toBeLessThanOrEqual(100 + 80);
      expect(p[2]).toBeGreaterThanOrEqual(10);
      expect(p[2]).toBeLessThanOrEqual(30);
    }
    expect(log).toContainEqual(['set fillStyle', 'navy']);
    expect(log).toContainEqual(['set strokeStyle', 'white']);
    expect(log.map(([n]) => n)).toContain('fill');
    expect(log.map(([n]) => n)).toContain('stroke');
  });
});
