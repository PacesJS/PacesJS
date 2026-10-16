import { describe, expect, it } from 'vitest';
import { createState, reducer, snapshotOf } from '../../src/state/reducer';
import {
  addTransform,
  removeTransform,
  rewindTo,
  transformLabel,
} from '../../src/state/transforms';
import { DEFAULT_TRANSFORMS, initialSnapshot } from '../../src/state/types';

describe('app state', () => {
  it('opens with the default transform stack visible', () => {
    expect(snapshotOf(createState(initialSnapshot())).transforms).toEqual(DEFAULT_TRANSFORMS);
  });

  it('puts selection changes, view switches and transforms on one back stack', () => {
    let s = createState(initialSnapshot());
    s = reducer(s, { type: 'select', selection: { kind: 'fn', fn: 4 } });
    s = reducer(s, { type: 'go', patch: { view: 'flame' } });
    s = reducer(s, { type: 'add-transform', transform: { k: 'merge-fn', fn: 4 } });
    s = reducer(s, { type: 'back' });
    expect(snapshotOf(s).transforms).toEqual(DEFAULT_TRANSFORMS);
    s = reducer(s, { type: 'back' });
    expect(snapshotOf(s).view).toBe('waterfall');
    expect(snapshotOf(s).selection).toEqual({ kind: 'fn', fn: 4 });
    s = reducer(s, { type: 'forward' });
    expect(snapshotOf(s).view).toBe('flame');
  });

  it('applies a Show me as one history step', () => {
    let s = createState(initialSnapshot());
    s = reducer(s, {
      type: 'go',
      patch: {
        view: 'waterfall',
        selection: { kind: 'task', track: 'main', task: 2 },
        range: [1, 9],
      },
      options: { critical: true, task: 2 },
    });
    expect(s.history.entries).toHaveLength(2);
    s = reducer(s, { type: 'back' });
    expect(snapshotOf(s).range).toBeNull();
  });

  it('does not touch history on hover', () => {
    let s = createState(initialSnapshot());
    s = reducer(s, { type: 'hover', selection: { kind: 'fn', fn: 1 } });
    expect(s.history.entries).toHaveLength(1);
    expect(s.hover).toEqual({ kind: 'fn', fn: 1 });
  });
});

describe('transform stack', () => {
  it('removes one chip without touching the others', () => {
    expect(removeTransform(DEFAULT_TRANSFORMS, 2).map((t) => t.k)).toEqual([
      'stitch',
      'collapse-deps',
      'drop-idle',
    ]);
  });

  it('rewinds to a chip by dropping everything after it', () => {
    expect(rewindTo(DEFAULT_TRANSFORMS, 1).map((t) => t.k)).toEqual(['stitch', 'collapse-deps']);
  });

  it('does not stack duplicates and toggles invert', () => {
    const once = addTransform(DEFAULT_TRANSFORMS, { k: 'merge-fn', fn: 3 });
    expect(addTransform(once, { k: 'merge-fn', fn: 3 })).toHaveLength(once.length);
    const inverted = addTransform(once, { k: 'invert' });
    expect(addTransform(inverted, { k: 'invert' })).toEqual(once);
  });

  it('labels chips in plain words', () => {
    expect(transformLabel({ k: 'collapse-deps' }, String)).toBe('Collapse dependencies');
    expect(transformLabel({ k: 'stitch' }, String)).toBe('Stitch continuations (inferred)');
    expect(transformLabel({ k: 'merge-fn', fn: 9 }, () => 'lineTotal')).toBe('Merge lineTotal');
  });
});
