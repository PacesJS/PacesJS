/** Truncate in the middle so both ends of a long name stay readable. Empty when it cannot fit. */
export function midTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars < 5) return '';
  const head = Math.ceil((maxChars - 1) / 2);
  const tail = Math.floor((maxChars - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/**
 * `name · file:line` when it fits, then `name`, then nothing.
 * `maxChars` is the character budget of the available width.
 */
export function fitLabel(name: string, location: string, maxChars: number): string {
  const full = location ? `${name} · ${location}` : name;
  if (full.length <= maxChars) return full;
  return midTruncate(name, maxChars);
}

/** Character budget for a pixel width, given an average glyph width. */
export function charBudget(widthPx: number, paddingPx: number, glyphPx: number): number {
  return Math.max(0, Math.floor((widthPx - paddingPx) / glyphPx));
}
