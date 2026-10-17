// How deep call chains are drawn in the CALL column. The first levels indent in full steps so the
// tree reads like a tree; deeper ones squeeze, and the indent never takes more than half of the
// column, so the name always keeps room. A badge states the real depth once the indent no longer
// can, and the deepest rows offer to re-root there.

/** Full steps for this many levels, then medium steps, then thin ones. */
const FULL_LEVELS = 6;
const MEDIUM_LEVELS = 16;
export const FULL_STEP_PX = 16;
const MEDIUM_STEP_PX = 6;
const THIN_STEP_PX = 2;
/** The indent never takes more than this share of the column. */
const MAX_INDENT_SHARE = 0.5;
/** Rows deeper than this carry a `⋯ N` depth badge. */
export const BADGE_DEPTH = 8;
/** Rows deeper than this offer "Focus here". */
export const FOCUS_DEPTH = 12;

/** Left indent in px of a row at `depth` (0 is the root), in a name column `columnPx` wide. */
export function indentFor(depth: number, columnPx: number): number {
  const d = Math.max(0, Math.floor(depth));
  const full = Math.min(d, FULL_LEVELS);
  const medium = Math.min(Math.max(d - FULL_LEVELS, 0), MEDIUM_LEVELS - FULL_LEVELS);
  const thin = Math.max(d - MEDIUM_LEVELS, 0);
  const px = full * FULL_STEP_PX + medium * MEDIUM_STEP_PX + thin * THIN_STEP_PX;
  return Math.max(0, Math.min(px, Math.floor(Math.max(0, columnPx) * MAX_INDENT_SHARE)));
}

/** Levels that get a faint vertical guide line. */
export const guideLevels = (depth: number): number => Math.min(Math.max(depth, 0), FULL_LEVELS);

/**
 * `text` cut in the middle with an ellipsis until `measure` says it fits in `maxPx`. Both ends
 * stay readable: a function name's start says what it is, its end often says which one.
 */
export function middleEllipsis(
  text: string,
  maxPx: number,
  measure: (s: string) => number,
): string {
  if (measure(text) <= maxPx) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length - 1;
  let best = '…';
  while (lo <= hi) {
    const keep = Math.floor((lo + hi) / 2);
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    const cut = `${chars.slice(0, head).join('')}…${tail > 0 ? chars.slice(-tail).join('') : ''}`;
    if (measure(cut) <= maxPx) {
      best = cut;
      lo = keep + 1;
    } else hi = keep - 1;
  }
  return best;
}
