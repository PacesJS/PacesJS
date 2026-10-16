export interface LinearScale {
  (v: number): number;
  invert(px: number): number;
  domain: readonly [number, number];
  range: readonly [number, number];
}

export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const f = ((v: number) => r0 + ((v - d0) / span) * (r1 - r0)) as LinearScale;
  f.invert = (px: number) => d0 + ((px - r0) / (r1 - r0 || 1)) * span;
  f.domain = domain;
  f.range = range;
  return f;
}

/** "Nice" tick step (1, 2 or 5 times a power of ten) giving about `count` ticks. */
export function niceStep(span: number, count: number): number {
  if (!(span > 0) || count < 1) return 1;
  const raw = span / count;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const base = raw / pow;
  const mult = base >= 7.5 ? 10 : base >= 3.5 ? 5 : base >= 1.5 ? 2 : 1;
  return mult * pow;
}

/** Tick values in `[min, max]`, multiples of a nice step, starting at the first multiple >= min. */
export function niceTicks(min: number, max: number, count: number): number[] {
  const step = niceStep(max - min, count);
  const first = Math.ceil(min / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = first; v <= max + step * 1e-9; v += step) {
    out.push(Math.round(v / step) * step + 0);
  }
  return out;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
