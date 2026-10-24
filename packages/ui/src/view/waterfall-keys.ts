import type { WaterfallRow } from '../data/types';

/** What a key does in the waterfall. `noop` is a handled key with nothing to do (the browser default is still blocked). */
export type WaterfallKeyAction =
  | { type: 'select'; row: WaterfallRow }
  | { type: 'collapse'; collapsed: ReadonlySet<number> }
  | { type: 'open-dock' }
  /** Enter on a row that only the keyboard rests on (a fold or summary): do what a click does. */
  | { type: 'activate'; row: WaterfallRow }
  | { type: 'back' }
  | { type: 'noop' };

interface KeyState {
  /** Indexes into `rows` of the rows on screen, in order. */
  visible: readonly number[];
  rows: readonly WaterfallRow[];
  collapsed: ReadonlySet<number>;
  selectedRowId: number | null;
}

/**
 * Fold and summary rows stand for rows that are not there; selecting one would change the view or
 * toggle it, so the keyboard rests on them without selecting and acts only on Enter.
 */
export function isCursorOnly(row: WaterfallRow): boolean {
  return row.kind === 'fold' || row.kind === 'summary';
}

/** Arrows walk and fold rows, Enter opens the source, Backspace goes back; null for any other key. */
export function waterfallKeyAction(key: string, s: KeyState): WaterfallKeyAction | null {
  const { visible, rows, collapsed } = s;
  const idx = visible.findIndex((ri) => (rows[ri] as WaterfallRow).id === s.selectedRowId);
  const cur = idx >= 0 ? (rows[visible[idx] as number] as WaterfallRow) : null;
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const next =
      idx < 0 ? 0 : Math.max(0, Math.min(visible.length - 1, idx + (key === 'ArrowDown' ? 1 : -1)));
    const row = rows[visible[next] as number];
    return row ? { type: 'select', row } : { type: 'noop' };
  }
  if (key === 'ArrowLeft' && cur) {
    if (cur.hasChildren && !collapsed.has(cur.id)) {
      return { type: 'collapse', collapsed: new Set([...collapsed, cur.id]) };
    }
    for (let k = idx - 1; k >= 0; k--) {
      const parent = rows[visible[k] as number] as WaterfallRow;
      if (parent.depth < cur.depth) return { type: 'select', row: parent };
    }
    return { type: 'noop' };
  }
  if (key === 'ArrowRight' && cur) {
    if (collapsed.has(cur.id)) {
      const open = new Set(collapsed);
      open.delete(cur.id);
      return { type: 'collapse', collapsed: open };
    }
    const next = rows[visible[idx + 1] as number];
    return next && next.depth > cur.depth ? { type: 'select', row: next } : { type: 'noop' };
  }
  if (key === 'Enter' && cur) {
    return isCursorOnly(cur) ? { type: 'activate', row: cur } : { type: 'open-dock' };
  }
  if (key === 'Backspace') return { type: 'back' };
  return null;
}
