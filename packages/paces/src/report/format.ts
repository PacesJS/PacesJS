/** Sampled time for people and agents: `~` prefix, ms below 10 s, seconds above. */
export function fmtUs(us: number): string {
  const ms = us / 1000;
  if (ms >= 10_000) return `~${(ms / 1000).toFixed(1)} s`;
  if (ms >= 10) return `~${Math.round(ms)} ms`;
  if (ms >= 0.05) return `~${ms.toFixed(1)} ms`;
  return '~0 ms';
}

export function fmtPct(share: number): string {
  const p = share * 100;
  if (p >= 10) return `${Math.round(p)}%`;
  if (p >= 0.1) return `${p.toFixed(1)}%`;
  return '<0.1%';
}

/** A duration column: right-aligned in nine characters. */
export const timeCol = (us: number): string => padStart(fmtUs(us), 9);

/** A share column: right-aligned in five characters. */
export const pctCol = (share: number): string => padStart(fmtPct(share), 5);

export const orAnon = (name: string): string => name || '(anonymous)';

/** Shares in JSON, to three decimals. */
export const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** `.../node_modules/.pnpm/x@1/node_modules/pkg/lib/a.js` -> `pkg/lib/a.js`. */
export function shortPath(file: string): string {
  const f = file.replaceAll('\\', '/');
  const i = f.lastIndexOf('node_modules/');
  return i >= 0 ? f.slice(i + 'node_modules/'.length) : f;
}

export function place(file: string, line: number): string {
  if (!file) return '';
  const p = shortPath(file);
  return line > 0 ? `${p}:${line}` : p;
}

const ANSI = {
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  reset: '\u001b[0m',
} as const;

export function painter(enabled: boolean) {
  const wrap = (code: keyof typeof ANSI) => (s: string) =>
    enabled ? `${ANSI[code]}${s}${ANSI.reset}` : s;
  return { dim: wrap('dim'), bold: wrap('bold'), red: wrap('red') };
}

export type Painter = ReturnType<typeof painter>;

/** Pads on the right to `width`, never truncating. */
export const padEnd = (s: string, width: number): string =>
  s.length >= width ? s : s + ' '.repeat(width - s.length);
export const padStart = (s: string, width: number): string =>
  s.length >= width ? s : ' '.repeat(width - s.length) + s;

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;
}

/** Quotes a path or selector for the next copy-pasted command, for bash and PowerShell alike. */
export function shellArg(s: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${s.replaceAll('"', '\\"')}"`;
}
