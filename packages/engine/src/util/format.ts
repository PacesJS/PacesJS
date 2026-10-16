/** Durations: ms below 10 s, s above. `approx` adds the sampled-estimate prefix. */
export function formatDuration(us: number, approx = true): string {
  const prefix = approx ? '~' : '';
  const ms = us / 1000;
  if (ms >= 10_000) return `${prefix}${(ms / 1000).toFixed(1)} s`;
  if (ms >= 100) return `${prefix}${Math.round(ms)} ms`;
  if (ms >= 10) return `${prefix}${ms.toFixed(0)} ms`;
  if (ms >= 1) return `${prefix}${ms.toFixed(1)} ms`;
  return `${prefix}${ms.toFixed(2)} ms`;
}

export function formatPercent(share: number): string {
  const p = share * 100;
  return `${p >= 10 ? p.toFixed(0) : p.toFixed(1)}%`;
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
