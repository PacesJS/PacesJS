import { describe, expect, it, vi } from 'vitest';
import { popTarget, stepBrowser, urlAction } from '../../src/state/browser-history';
import { createHistory, push } from '../../src/state/history';
import { initialSnapshot } from '../../src/state/types';

const at = (fn: number) => ({ ...initialSnapshot(), selection: { kind: 'fn', fn } as const });

describe('urlAction: how the URL follows the in-app history', () => {
  const h0 = createHistory(initialSnapshot());

  it('stamps the opening entry on first sight', () => {
    expect(urlAction(null, h0, '#a', '')).toBe('stamp');
  });

  it('pushes a browser entry when a new history entry was pushed', () => {
    const h1 = push(h0, at(1));
    expect(urlAction({ serial: h0.serial, index: h0.index }, h1, '#b', '#a')).toBe('push');
  });

  it('does nothing when the browser itself moved (the URL is already right)', () => {
    const h1 = push(h0, at(1));
    const moved = { ...h1, index: 0 };
    expect(urlAction({ serial: h1.serial, index: h1.index }, moved, '#a', '#a')).toBe('none');
  });

  it('replaces the entry when the same entry was edited (a drag, an option)', () => {
    expect(urlAction({ serial: h0.serial, index: 0 }, h0, '#b', '#a')).toBe('replace');
  });

  it('leaves an up-to-date URL alone', () => {
    expect(urlAction({ serial: h0.serial, index: 0 }, h0, '#a', '#a')).toBe('none');
  });
});

describe('popTarget: what a browser back or forward means for the app', () => {
  it('moves to the matching in-app entry when the browser state names one', () => {
    let h = createHistory(initialSnapshot());
    h = push(h, at(1));
    expect(popTarget(h, { i: 0 })).toEqual({ kind: 'goto', index: 0 });
  });

  it('adopts the URL when the browser state is unknown (a reload, a pasted link)', () => {
    const h = createHistory(initialSnapshot());
    expect(popTarget(h, null)).toEqual({ kind: 'restore' });
    expect(popTarget(h, { i: 7 })).toEqual({ kind: 'restore' });
  });
});

describe('stepBrowser', () => {
  it('goes through the browser history when it can move', () => {
    let h = createHistory(initialSnapshot());
    h = push(h, at(1));
    const go = vi.fn();
    const dispatch = vi.fn();
    stepBrowser(-1, h, { go }, dispatch);
    expect(go).toHaveBeenCalledWith(-1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does nothing at the ends of the stack', () => {
    const h = createHistory(initialSnapshot());
    const go = vi.fn();
    stepBrowser(-1, h, { go }, vi.fn());
    stepBrowser(1, h, { go }, vi.fn());
    expect(go).not.toHaveBeenCalled();
  });

  it('falls back to the in-app stack when there is no browser history to drive', () => {
    let h = createHistory(initialSnapshot());
    h = push(h, at(1));
    const dispatch = vi.fn();
    stepBrowser(-1, h, undefined, dispatch);
    expect(dispatch).toHaveBeenCalledWith({ type: 'back' });
  });
});
