import { describe, expect, it } from 'vitest';
import type { Palette } from '../../src/theme/palette';
import { flameFill } from '../../src/view/flame-fill';

const pal = {
  flameRoot: 'root',
  diffFaster: 'green',
  diffSlower: 'red',
  accent: 'orange',
  originSolid: ['solid0', 'solid1'],
  originDim: ['dim0', 'dim1', 'dim2'],
} as unknown as Palette;

const data = (over: Record<string, unknown>) =>
  ({
    origin: Uint8Array.of(0, 2),
    node: Int32Array.of(5, 6),
    delta: null,
    heat: Float32Array.of(0.25, 1),
    ...over,
  }) as unknown as Parameters<typeof flameFill>[1];

describe('flameFill', () => {
  it('uses the neutral color for the root', () => {
    expect(flameFill(pal, data({ node: Int32Array.of(-1, 6) }), 0, 'origin')).toBe('root');
  });

  it('tints faster and slower diffs by size', () => {
    const delta = Float64Array.of(-0.25, 1);
    expect(flameFill(pal, data({ delta }), 0, 'origin')).toBe(
      'color-mix(in srgb, green 54%, transparent)',
    );
    expect(flameFill(pal, data({ delta }), 1, 'origin')).toBe(
      'color-mix(in srgb, red 95%, transparent)',
    );
  });

  it('deepens with self time in self mode', () => {
    expect(flameFill(pal, data({}), 0, 'self')).toBe('color-mix(in srgb, orange 55%, transparent)');
  });

  it('uses the solid origin color for your code and the dim one for the rest', () => {
    expect(flameFill(pal, data({}), 0, 'origin')).toBe('solid0');
    expect(flameFill(pal, data({}), 1, 'origin')).toBe('dim2');
    expect(flameFill(pal, data({ origin: Uint8Array.of(9, 9) }), 0, 'origin')).toBe('orange');
  });
});
