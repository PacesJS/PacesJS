import { describe, expect, it } from 'vitest';
import {
  back,
  canBack,
  canForward,
  createHistory,
  current,
  forward,
  goto,
  push,
  replace,
} from '../../src/state/history';
import { initialSnapshot } from '../../src/state/types';

const at = (fn: number) => ({ ...initialSnapshot(), selection: { kind: 'fn', fn } as const });

describe('history', () => {
  it('goes back and forward across pushed snapshots', () => {
    let h = createHistory(initialSnapshot());
    h = push(h, at(1));
    h = push(h, at(2));
    h = back(h);
    expect(current(h).selection).toEqual({ kind: 'fn', fn: 1 });
    expect(canForward(h)).toBe(true);
    h = forward(h);
    expect(current(h).selection).toEqual({ kind: 'fn', fn: 2 });
  });

  it('drops the forward entries when pushing after going back', () => {
    let h = createHistory(initialSnapshot());
    h = push(h, at(1));
    h = push(h, at(2));
    h = back(h);
    h = push(h, at(3));
    expect(canForward(h)).toBe(false);
    expect(h.entries).toHaveLength(3);
  });

  it('does not add an entry for an identical screen', () => {
    const h = createHistory(initialSnapshot());
    expect(push(h, initialSnapshot())).toBe(h);
  });

  it('stays put at both ends', () => {
    const h = createHistory(initialSnapshot());
    expect(canBack(h)).toBe(false);
    expect(back(h)).toBe(h);
    expect(forward(h)).toBe(h);
  });

  it('counts pushes, so the URL layer can tell a new entry from a replaced one', () => {
    let h = createHistory(initialSnapshot());
    const first = h.serial;
    h = push(h, at(1));
    expect(h.serial).toBe(first + 1);
    h = replace(h, at(2));
    expect(h.serial).toBe(first + 1);
    h = back(h);
    expect(h.serial).toBe(first + 1);
    h = forward(h);
    expect(h.serial).toBe(first + 1);
  });

  it('jumps to an entry by index and ignores an index that is not there', () => {
    let h = createHistory(initialSnapshot());
    h = push(h, at(1));
    h = push(h, at(2));
    h = goto(h, 0);
    expect(h.index).toBe(0);
    expect(goto(h, 5)).toBe(h);
    expect(goto(h, -1)).toBe(h);
  });
});
