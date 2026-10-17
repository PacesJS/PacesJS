import type { Transform } from './types';

/**
 * The transform behind "Focus here" and the `f` key. A call node is the most exact, but a path
 * through a collapsed package holds ids the engine cannot take (they only exist in this view),
 * and it would silently do nothing; then the function itself is focused. `null` when neither is a
 * real function (a collapsed package on its own).
 */
export function focusTransform(
  path: readonly number[] | null,
  fn: number | null,
  functionCount: number,
): Transform | null {
  if (path && path.length > 0 && path.every((id) => id < functionCount)) {
    return { k: 'focus-node', path: [...path] };
  }
  if (fn !== null && fn < functionCount) return { k: 'focus-fn', fn };
  return null;
}
