/** The origin palette. One module; colors live in tokens.css and are referenced by variable. */

export type OriginKey = 'you' | 'dependency' | 'framework' | 'node' | 'native' | 'gc' | 'idle';

export interface OriginInfo {
  key: OriginKey;
  /** Legend and row label: the second cue next to color. */
  label: string;
  /** Short word shown in tables. */
  short: string;
  /** Solid color token. */
  solid: string;
  /** 45%-opacity token for non-user frames (user code is never dimmed). */
  dim: string;
  /** Second, non-color cue: glyph drawn in the legend swatch and on wide bars. */
  glyph: string;
  /** Canvas pattern cue for the swatch: solid, stripe, dot, grid, cross, ring. */
  pattern: 'solid' | 'stripe' | 'dot' | 'grid' | 'cross' | 'ring';
}

/** Indexed by the engine's numeric origin: user, dependency, framework, node, native, idle, gc. */
export const ORIGINS: readonly OriginInfo[] = [
  {
    key: 'you',
    label: 'Your code',
    short: 'Your code',
    solid: '--c-origin-you',
    dim: '--c-origin-you-dim',
    glyph: '●',
    pattern: 'solid',
  },
  {
    key: 'dependency',
    label: 'Dependency',
    short: 'Dependency',
    solid: '--c-origin-dependency',
    dim: '--c-origin-dependency-dim',
    glyph: '◆',
    pattern: 'stripe',
  },
  {
    key: 'framework',
    label: 'Framework',
    short: 'Framework',
    solid: '--c-origin-framework',
    dim: '--c-origin-framework-dim',
    glyph: '▲',
    pattern: 'dot',
  },
  {
    key: 'node',
    label: 'Node internals',
    short: 'Node',
    solid: '--c-origin-node',
    dim: '--c-origin-node-dim',
    glyph: '■',
    pattern: 'grid',
  },
  {
    key: 'native',
    label: 'Native',
    short: 'Native',
    solid: '--c-origin-native',
    dim: '--c-origin-native-dim',
    glyph: '✚',
    pattern: 'cross',
  },
  {
    key: 'idle',
    label: 'Idle',
    short: 'Idle',
    solid: '--c-origin-gc',
    dim: '--c-origin-gc-dim',
    glyph: '○',
    pattern: 'ring',
  },
  {
    key: 'gc',
    label: 'GC',
    short: 'GC',
    solid: '--c-origin-gc',
    dim: '--c-origin-gc-dim',
    glyph: '▬',
    pattern: 'ring',
  },
];

export const LEGEND_ORDER: readonly number[] = [0, 1, 2, 3, 4, 6];

export function originInfo(origin: number): OriginInfo {
  return ORIGINS[origin] ?? (ORIGINS[4] as OriginInfo);
}

export const isUserOrigin = (origin: number): boolean => origin === 0;

/** CSS color for DOM use. */
export function originColor(origin: number, dimNonUser = true): string {
  const o = originInfo(origin);
  return `var(${dimNonUser && origin !== 0 ? o.dim : o.solid})`;
}

export function originSolid(origin: number): string {
  return `var(${originInfo(origin).solid})`;
}
