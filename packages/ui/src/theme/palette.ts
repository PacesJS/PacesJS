import { ORIGINS } from './origin';

/** Canvas cannot read CSS variables: resolve them once per theme into plain strings. */
export interface Palette {
  ink: string;
  muted: string;
  line: string;
  surface: string;
  bg: string;
  accent: string;
  accentInk: string;
  accentTint: string;
  accentFill: string;
  outline: string;
  wait: string;
  cpuLine: string;
  cpuFill: string;
  gcTick: string;
  gcLong: string;
  delayLine: string;
  sevMedium: string;
  flameRoot: string;
  fontSans: string;
  fontMono: string;
  grid: string;
  diffFaster: string;
  diffSlower: string;
  /** Solid and dim colors per origin index. */
  originSolid: string[];
  originDim: string[];
}

export function readPalette(el: Element = document.documentElement): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string): string => cs.getPropertyValue(name).trim();
  return {
    ink: v('--c-ink'),
    muted: v('--c-muted'),
    line: v('--c-line'),
    surface: v('--c-surface'),
    bg: v('--c-bg'),
    accent: v('--c-accent'),
    accentInk: v('--c-accent-ink'),
    accentTint: v('--c-accent-tint'),
    accentFill: v('--c-cpu-fill'),
    outline: v('--c-outline'),
    wait: v('--c-wait'),
    cpuLine: v('--c-cpu-line'),
    cpuFill: v('--c-cpu-fill'),
    gcTick: v('--c-gc-tick'),
    gcLong: v('--c-gc-long'),
    delayLine: v('--c-delay-line'),
    sevMedium: v('--c-sev-medium'),
    flameRoot: v('--c-flame-root'),
    fontSans: v('--font-sans'),
    fontMono: v('--font-mono'),
    grid: v('--c-grid'),
    diffFaster: v('--c-diff-faster'),
    diffSlower: v('--c-diff-slower'),
    originSolid: ORIGINS.map((o) => v(o.solid)),
    originDim: ORIGINS.map((o) => v(o.dim)),
  };
}
