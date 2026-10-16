import { snapshotToHash } from './hash';
import type { Snapshot } from './types';

/** Back/forward stack over whole-screen snapshots (selection, view, range, transforms). */
export interface History {
  entries: Snapshot[];
  index: number;
}

const MAX_ENTRIES = 200;

export function createHistory(initial: Snapshot): History {
  return { entries: [initial], index: 0 };
}

export function current(h: History): Snapshot {
  return h.entries[h.index] as Snapshot;
}

export function push(h: History, next: Snapshot): History {
  if (snapshotToHash(current(h)) === snapshotToHash(next)) return h;
  const kept = h.entries.slice(0, h.index + 1);
  kept.push(next);
  const trimmed = kept.length > MAX_ENTRIES ? kept.slice(kept.length - MAX_ENTRIES) : kept;
  return { entries: trimmed, index: trimmed.length - 1 };
}

/** Replace the current entry without growing the stack (for hash edits and drags). */
export function replace(h: History, next: Snapshot): History {
  const entries = h.entries.slice();
  entries[h.index] = next;
  return { entries, index: h.index };
}

export const canBack = (h: History): boolean => h.index > 0;
export const canForward = (h: History): boolean => h.index < h.entries.length - 1;

export function back(h: History): History {
  return canBack(h) ? { entries: h.entries, index: h.index - 1 } : h;
}

export function forward(h: History): History {
  return canForward(h) ? { entries: h.entries, index: h.index + 1 } : h;
}
