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

/** Microseconds as milliseconds at 0.1 ms resolution, for JSON digests. */
export const ms = (us: number): number => Math.round(us / 100) / 10;

/** A 0..1 share rounded to three decimals, for JSON digests. */
export const share = (x: number): number => Math.round(x * 1000) / 1000;

/** `172 KB`, `1.4 MB`: sizes on the wire, whole kilobytes below a megabyte. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
