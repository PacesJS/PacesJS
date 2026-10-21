/** Unit labelling. Sampled values carry "~"; exact (instrumented) values drop it. */

const TEXT = {
  approx: '~',
  millis: (value: string) => `${value} ms`,
  seconds: (value: string) => `${value} s`,
  percent: (value: string) => `${value}%`,
  noShare: '0.0%',
  rangeMillis: (from: string, to: string) => `${from}–${to} ms`,
  rangeSeconds: (from: string, to: string) => `${from}–${to} s`,
} as const;

export interface DurationOptions {
  /** Prefix "~" for sampled estimates. Default true. */
  approx?: boolean;
  /** Decimals for milliseconds. Default: 0 from 100 ms up, otherwise 1. */
  decimals?: number;
}

const tilde = (approx: boolean | undefined): string => (approx === false ? '' : TEXT.approx);

/** Microseconds to a label: ms below 10 s, seconds above. */
export function fmtDuration(us: number, opts: DurationOptions = {}): string {
  const ms = us / 1000;
  if (ms >= 10_000) return `${tilde(opts.approx)}${TEXT.seconds((ms / 1000).toFixed(1))}`;
  const decimals = opts.decimals ?? (ms >= 100 ? 0 : 1);
  return `${tilde(opts.approx)}${TEXT.millis(ms.toFixed(decimals))}`;
}

/** Microseconds as seconds with a fixed number of decimals, e.g. "1.25 s". */
export function fmtSeconds(us: number, decimals: number): string {
  return TEXT.seconds((us / 1_000_000).toFixed(decimals));
}

/** Whole-run duration, e.g. "42.8 s". Exact: it is wall-clock, not sampled. */
export function fmtRun(us: number): string {
  if (us >= 1_000_000) return fmtSeconds(us, us >= 10_000_000 ? 1 : 2);
  return fmtDuration(us, { approx: false, decimals: 0 });
}

export function fmtShare(fraction: number): string {
  if (!Number.isFinite(fraction)) return TEXT.noShare;
  return TEXT.percent((fraction * 100).toFixed(1));
}

/** Estimated count, e.g. "~1,340". */
export function fmtCount(n: number, approx = true): string {
  return `${approx ? TEXT.approx : ''}${Math.round(n).toLocaleString('en-US')}`;
}

/** Compact axis label for a timestamp in microseconds. */
export function fmtAxis(us: number, unit: 's' | 'ms', withUnit: boolean): string {
  const v = unit === 's' ? us / 1_000_000 : us / 1000;
  const text = Number.isInteger(v) ? String(v) : v.toFixed(unit === 's' ? 1 : 2).replace(/0+$/, '');
  return withUnit ? `${text} ${unit}` : text;
}

/** "18.0–19.6 s" for range chips. */
export function fmtRange(fromUs: number, toUs: number): string {
  const f = fromUs / 1_000_000;
  const t = toUs / 1_000_000;
  if (t - f < 1) return TEXT.rangeMillis((fromUs / 1000).toFixed(0), (toUs / 1000).toFixed(0));
  return TEXT.rangeSeconds(f.toFixed(1), t.toFixed(1));
}

/**
 * Shorten an entry path for display: `.../node_modules/.pnpm/x@1/node_modules/x/bin/x.js` becomes
 * `x/bin/x.js`; other paths are unchanged.
 */
export function displayEntry(path: string): string {
  const marker = 'node_modules/';
  const at = path.lastIndexOf(marker);
  return at < 0 ? path : path.slice(at + marker.length);
}
