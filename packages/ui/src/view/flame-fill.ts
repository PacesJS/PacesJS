import type { FlameData } from '../data/types';
import type { Palette } from '../theme/palette';

type FillData = Pick<FlameData, 'origin' | 'node' | 'delta' | 'heat'>;

/**
 * Fill color of one flame rect: the root is neutral, a diff tints faster or slower by size, "self"
 * deepens with self time, and otherwise the origin color (dim for anything but your own code).
 */
export function flameFill(
  pal: Palette,
  data: FillData,
  i: number,
  color: 'origin' | 'self',
): string {
  const origin = data.origin[i] ?? 4;
  if (data.node[i] === -1) return pal.flameRoot;
  const d = data.delta ? (data.delta[i] ?? 0) : null;
  if (d !== null) {
    const hue = d < 0 ? pal.diffFaster : pal.diffSlower;
    return `color-mix(in srgb, ${hue} ${Math.round(12 + 83 * Math.sqrt(Math.abs(d)))}%, transparent)`;
  }
  if (color === 'self')
    return `color-mix(in srgb, ${pal.accent} ${Math.round(15 + 80 * Math.sqrt(data.heat[i] ?? 0))}%, transparent)`;
  return origin === 0 ? (pal.originSolid[0] ?? pal.accent) : (pal.originDim[origin] ?? pal.accent);
}
