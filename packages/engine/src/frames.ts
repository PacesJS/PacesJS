import { Origin } from './model.js';
import type { ExecutionModel, FnId } from './model.js';

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

/** The function's name as stored: empty for an anonymous function. */
export function functionName(model: ExecutionModel, fn: FnId): string {
  return model.strings[model.functions.name[fn] ?? 0] ?? '';
}
