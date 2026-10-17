import { Origin } from './model.js';

/** Runtime frames (native, Node, idle, GC) and plumbing: everything that is not the program's own code. */
export function isRuntimeFn(
  functions: { origin: Uint8Array; plumbing: Uint8Array },
  fn: number,
): boolean {
  const o = functions.origin[fn] ?? Origin.User;
  return (
    o === Origin.Native ||
    o === Origin.Node ||
    o === Origin.Idle ||
    o === Origin.Gc ||
    functions.plumbing[fn] === 1
  );
}
