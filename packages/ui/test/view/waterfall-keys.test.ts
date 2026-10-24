import { describe, expect, it } from 'vitest';
import type { WaterfallRow } from '../../src/data/types';
import { isCursorOnly, waterfallKeyAction } from '../../src/view/waterfall-keys';

const row = (id: number, depth: number, hasChildren = false, kind = 'call'): WaterfallRow =>
  ({ id, depth, hasChildren, kind }) as WaterfallRow;

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

describe('rows the keyboard rests on without selecting', () => {
  it.each([
    ['fold', true],
    ['summary', true],
    ['call', false],
    ['task', false],
    ['wait', false],
  ])('%s row: cursor only is %s', (kind, expected) => {
    expect(isCursorOnly(row(0, 0, false, kind))).toBe(expected);
  });

  // root(0) > a(1), bootstrap fold(2) collapsed, then b(3)
  const withFold = [row(0, 0, true), row(1, 1), row(2, 1, true, 'fold'), row(3, 1)];
  const foldState = (selectedRowId: number | null, collapsed: number[] = [2]) => ({
    visible: [0, 1, 2, 3],
    rows: withFold,
    collapsed: new Set(collapsed),
    selectedRowId,
  });

  it('walks down onto the fold row, then past it', () => {
    expect(waterfallKeyAction('ArrowDown', foldState(1))).toEqual({
      type: 'select',
      row: withFold[2],
    });
    expect(waterfallKeyAction('ArrowDown', foldState(2))).toEqual({
      type: 'select',
      row: withFold[3],
    });
  });

  it('walks back up from the row after the fold, onto the fold', () => {
    expect(waterfallKeyAction('ArrowUp', foldState(3))).toEqual({
      type: 'select',
      row: withFold[2],
    });
  });

  it('activates the fold row on Enter instead of opening the source', () => {
    expect(waterfallKeyAction('Enter', foldState(2))).toEqual({
      type: 'activate',
      row: withFold[2],
    });
  });

  it('opens the fold on ArrowRight and closes it on ArrowLeft', () => {
    expect(waterfallKeyAction('ArrowRight', foldState(2))).toEqual({
      type: 'collapse',
      collapsed: new Set(),
    });
    expect(waterfallKeyAction('ArrowLeft', foldState(2, []))).toEqual({
      type: 'collapse',
      collapsed: new Set([2]),
    });
  });
});
