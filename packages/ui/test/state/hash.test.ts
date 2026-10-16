import { describe, expect, it } from 'vitest';
import { hashToSnapshot, snapshotToHash } from '../../src/state/hash';
import { DEFAULT_OPTIONS, initialSnapshot } from '../../src/state/types';
import type { Selection, Snapshot } from '../../src/state/types';

describe('url hash', () => {
  it('serializes the default screen compactly', () => {
    expect(snapshotToHash(initialSnapshot())).toBe('#v=waterfall');
  });

  it('restores defaults from an empty hash', () => {
    expect(hashToSnapshot('')).toEqual(initialSnapshot());
  });

  it('round-trips view, selection, range, transforms, track and options', () => {
    const snap: Snapshot = {
      view: 'flame',
      track: 'worker 1',
      selection: { kind: 'node', track: 'worker 1', path: [271, 279, 282] },
      range: [18_000_000, 19_600_000],
      transforms: [
        { k: 'collapse-deps' },
        { k: 'collapse-pkg', pkg: '@scope/pkg & co' },
        { k: 'merge-fn', fn: 7 },
        { k: 'focus-node', path: [3, 4] },
        { k: 'merge-node', path: [3] },
        { k: 'invert' },
      ],
      options: {
        ...DEFAULT_OPTIONS,
        critical: false,
        pathOnly: true,
        sort: 'alpha',
        zoom: [1, 5, 9],
        task: 4,
        line: 43,
        expanded: ['ajv', 'a|b'],
      },
    };
    expect(hashToSnapshot(snapshotToHash(snap))).toEqual(snap);
  });

  const selections: Selection[] = [
    { kind: 'fn', fn: 12 },
    { kind: 'node', track: 'main', path: [4, 5, 6] },
    { kind: 'task', track: 'main', task: 0 },
    { kind: 'range', from: 5, to: 99 },
  ];
  it.each(selections)('round-trips selection %j', (selection) => {
    const snap = { ...initialSnapshot(), selection };
    expect(hashToSnapshot(snapshotToHash(snap)).selection).toEqual(selection);
  });

  it('keeps an explicitly empty transform stack distinct from the defaults', () => {
    const snap = { ...initialSnapshot(), transforms: [] };
    expect(hashToSnapshot(snapshotToHash(snap)).transforms).toEqual([]);
  });

  it('ignores malformed parts instead of throwing', () => {
    const snap = hashToSnapshot('#v=nope&sel=fn:abc&r=9..1&t=bogus,merge:x,drop-idle&o=zoom:a');
    expect(snap.view).toBe('waterfall');
    expect(snap.selection).toEqual({ kind: 'none' });
    expect(snap.range).toBeNull();
    expect(snap.transforms).toEqual([{ k: 'drop-idle' }]);
  });
});
