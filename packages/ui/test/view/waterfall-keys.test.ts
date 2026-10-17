import { describe, expect, it } from 'vitest';
import type { WaterfallRow } from '../../src/data/types';
import { waterfallKeyAction } from '../../src/view/waterfall-keys';

const row = (id: number, depth: number, hasChildren = false): WaterfallRow =>
  ({ id, depth, hasChildren }) as WaterfallRow;

// root(0) > a(1) > b(2), then c(3) at depth 1
const rows = [row(0, 0, true), row(1, 1, true), row(2, 2), row(3, 1)];
const visible = [0, 1, 2, 3];
const state = (selectedRowId: number | null, collapsed: number[] = []) => ({
  visible,
  rows,
  collapsed: new Set(collapsed),
  selectedRowId,
});

describe('waterfallKeyAction', () => {
  it('selects the first row on ArrowDown with nothing selected', () => {
    expect(waterfallKeyAction('ArrowDown', state(null))).toEqual({ type: 'select', row: rows[0] });
  });

  it('stays on the last row at the end', () => {
    expect(waterfallKeyAction('ArrowDown', state(3))).toEqual({ type: 'select', row: rows[3] });
  });

  it('collapses an open parent on ArrowLeft, then moves to its parent', () => {
    const closed = waterfallKeyAction('ArrowLeft', state(1));
    expect(closed).toEqual({ type: 'collapse', collapsed: new Set([1]) });
    expect(waterfallKeyAction('ArrowLeft', state(1, [1]))).toEqual({
      type: 'select',
      row: rows[0],
    });
  });

  it('does nothing on ArrowLeft at a collapsed root, but still handles the key', () => {
    expect(waterfallKeyAction('ArrowLeft', state(0, [0]))).toEqual({ type: 'noop' });
  });

  it('opens a collapsed row on ArrowRight, else steps into its first child', () => {
    expect(waterfallKeyAction('ArrowRight', state(1, [1]))).toEqual({
      type: 'collapse',
      collapsed: new Set(),
    });
    expect(waterfallKeyAction('ArrowRight', state(1))).toEqual({ type: 'select', row: rows[2] });
    expect(waterfallKeyAction('ArrowRight', state(3))).toEqual({ type: 'noop' });
  });

  it('opens the dock on Enter only with a selection, goes back on Backspace, ignores other keys', () => {
    expect(waterfallKeyAction('Enter', state(1))).toEqual({ type: 'open-dock' });
    expect(waterfallKeyAction('Enter', state(null))).toBeNull();
    expect(waterfallKeyAction('Backspace', state(null))).toEqual({ type: 'back' });
    expect(waterfallKeyAction('x', state(1))).toBeNull();
  });
});
