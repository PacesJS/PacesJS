import type { CallTree } from '../model.js';
import type { RawTree } from './types.js';

/** Maps a raw tree's frames to function ids; the structure is shared, not copied. */
export function toCallTree(raw: RawTree, frameToFn: Uint32Array): CallTree {
  const fn = new Uint32Array(raw.length);
  for (let i = 0; i < raw.length; i++) fn[i] = frameToFn[raw.frame[i] ?? 0] ?? 0;
  return {
    length: raw.length,
    parent: raw.parent,
    fn,
    depth: raw.depth,
    subtreeEnd: raw.subtreeEnd,
    self: raw.self,
    total: raw.total,
  };
}
