import type { WaterfallRow } from '../data/types';
import type { Selection } from '../state/types';
import { samePath } from './waterfall-labels';

/**
 * Per call: CPU time (its own and its callees', never the awaiting between its segments) and how many
 * direct callees the minimum duration hides under it.
 */
export function rowFacts(rows: readonly WaterfallRow[]): {
  cpu: Map<number, number>;
  hidden: Map<number, number>;
} {
  const cpu = new Map<number, number>();
  const members = new Map<number, number>();
  for (const r of rows) members.set(r.parent, (members.get(r.parent) ?? 0) + 1);
  const hidden = new Map<number, number>();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i] as WaterfallRow;
    const mine = (cpu.get(r.id) ?? 0) + r.selfUs;
    cpu.set(r.id, mine);
    if (r.parent !== -1) cpu.set(r.parent, (cpu.get(r.parent) ?? 0) + mine);
    if (r.kind === 'fold' && r.fold === 'small') {
      hidden.set(r.parent, (hidden.get(r.parent) ?? 0) + (members.get(r.id) ?? 0));
    }
  }
  return { cpu, hidden };
}

/** The row the selection points at: the exact clicked row when it still matches, else the first match. */
export function selectedRowIdOf(
  rows: readonly WaterfallRow[],
  sel: Selection,
  trackId: string,
): number | null {
  const hit = (r: WaterfallRow): boolean => {
    if (sel.kind === 'node') return r.kind === 'call' && samePath(sel.path, r.path);
    if (sel.kind === 'task') return r.kind === 'task' && sel.track === trackId;
    if (sel.kind === 'fn') return r.kind === 'call' && r.fn === sel.fn;
    return false;
  };
  if (sel.kind === 'node' && sel.row !== undefined) {
    const exact = rows.find((r) => r.id === sel.row);
    if (exact && hit(exact)) return exact.id;
  }
  return rows.find(hit)?.id ?? null;
}
