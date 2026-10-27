/**
 * Minified JavaScript laid out for reading in the source panel. The layout comes from js-beautify,
 * which only changes whitespace, so every position in the original text keeps a place in the result:
 * `lineOf(line, col)` counts the characters that are not whitespace up to the position and finds
 * the formatted line that holds the next one.
 */

export interface FormattedSource {
  lines: string[];
  /** 1-based formatted line of a 1-based line and 0-based column of the original text. */
  lineOf(line: number, col: number): number;
}

/** A file whose lines are mostly too long to read: a bundle, not source. */
export function looksMinified(lines: readonly string[]): boolean {
  let longest = 0;
  let chars = 0;
  for (const l of lines) {
    longest = Math.max(longest, l.length);
    chars += l.length;
  }
  return longest > 1000 || (lines.length > 0 && chars / lines.length > 300);
}

const SPACE = /\s/;

function inkBefore(text: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < Math.min(to, text.length); i++) if (!SPACE.test(text[i] as string)) n++;
  return n;
}

/** Number of characters that are not whitespace in each prefix ending at a line start. */
function inkAtLineStarts(lines: readonly string[]): number[] {
  const out: number[] = [];
  let total = 0;
  for (const l of lines) {
    out.push(total);
    total += inkBefore(l, 0, l.length);
  }
  return out;
}

/** The text laid out, or null when it cannot be (the library failed, or changed more than whitespace). */
export async function formatMinified(text: string): Promise<FormattedSource | null> {
  let formatted: string;
  try {
    const mod = await import('js-beautify/js/lib/beautify.js');
    const beautify = (mod.js_beautify ?? mod.default?.js_beautify) as (
      source: string,
      options: Record<string, unknown>,
    ) => string;
    formatted = beautify(text, { indent_size: 2, preserve_newlines: false });
  } catch {
    return null;
  }
  const lines = formatted.split(/\r?\n/);
  const original = text.split(/\r?\n/);
  const ink = inkAtLineStarts(original);
  const inkTotal =
    (ink[ink.length - 1] ?? 0) + inkBefore(original[original.length - 1] ?? '', 0, Infinity);
  const shownInk = inkAtLineStarts(lines);
  const shownTotal =
    (shownInk[shownInk.length - 1] ?? 0) + inkBefore(lines[lines.length - 1] ?? '', 0, Infinity);
  if (inkTotal !== shownTotal) return null;
  return {
    lines,
    lineOf(line: number, col: number): number {
      const row = original[line - 1];
      if (row === undefined) return lines.length;
      const k = (ink[line - 1] ?? 0) + inkBefore(row, 0, Math.min(col, row.length));
      let lo = 0;
      let hi = shownInk.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if ((shownInk[mid] ?? 0) <= k) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    },
  };
}
