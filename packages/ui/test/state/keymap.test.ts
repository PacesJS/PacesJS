import { describe, expect, it } from 'vitest';
import { resolveKey } from '../../src/state/keymap';
import type { KeyAction } from '../../src/state/keymap';

describe('keymap', () => {
  const table: Array<[string, KeyAction]> = [
    ['1', { type: 'view', view: 'waterfall' }],
    ['2', { type: 'view', view: 'flame' }],
    ['3', { type: 'view', view: 'callgraph' }],
    ['4', { type: 'view', view: 'functions' }],
    ['5', { type: 'view', view: 'source' }],
    ['/', { type: 'focus-search' }],
    ['f', { type: 'focus-subtree' }],
    ['m', { type: 'merge' }],
    ['c', { type: 'collapse-pkg' }],
    ['i', { type: 'invert' }],
    ['p', { type: 'critical' }],
    ['?', { type: 'shortcuts' }],
  ];
  it.each(table)('maps %s', (key, action) => {
    expect(resolveKey({ key })).toEqual(action);
  });

  it('maps Alt+Left and Alt+Right to history', () => {
    expect(resolveKey({ key: 'ArrowLeft', altKey: true })).toEqual({ type: 'back' });
    expect(resolveKey({ key: 'ArrowRight', altKey: true })).toEqual({ type: 'forward' });
  });

  it('ignores plain keys while typing in a field', () => {
    expect(resolveKey({ key: '1', target: { tagName: 'INPUT' } })).toBeNull();
    expect(resolveKey({ key: 'f', target: { tagName: 'textarea' } })).toBeNull();
  });

  it('still lets Escape and Alt+arrows through while typing', () => {
    expect(resolveKey({ key: 'Escape', target: { tagName: 'INPUT' } })).toEqual({ type: 'escape' });
    expect(resolveKey({ key: 'ArrowLeft', altKey: true, target: { tagName: 'INPUT' } })).toEqual({
      type: 'back',
    });
  });

  it('leaves browser shortcuts alone', () => {
    expect(resolveKey({ key: 'f', ctrlKey: true })).toBeNull();
    expect(resolveKey({ key: 'c', metaKey: true })).toBeNull();
  });
});
