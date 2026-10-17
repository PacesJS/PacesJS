import { ORIGINS } from './origin';

/** Canvas cannot read CSS variables: resolve them once per theme into plain strings. */
export interface Palette {
  ink: string;
  accent: string;
  outline: string;
  cpuLine: string;
  cpuFill: string;
  gcTick: string;
  gcLong: string;
  delayLine: string;
  sevMedium: string;
  flameRoot: string;
  fontSans: string;
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
    accent: v('--c-accent'),
    outline: v('--c-outline'),
    cpuLine: v('--c-cpu-line'),
    cpuFill: v('--c-cpu-fill'),
    gcTick: v('--c-gc-tick'),
    gcLong: v('--c-gc-long'),
    delayLine: v('--c-delay-line'),
    sevMedium: v('--c-sev-medium'),
    flameRoot: v('--c-flame-root'),
    fontSans: v('--font-sans'),
    grid: v('--c-grid'),
    diffFaster: v('--c-diff-faster'),
    diffSlower: v('--c-diff-slower'),
    originSolid: ORIGINS.map((o) => v(o.solid)),
    originDim: ORIGINS.map((o) => v(o.dim)),
  };
}
