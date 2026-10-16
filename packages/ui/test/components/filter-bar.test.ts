import { describe, expect, it } from 'vitest';
import { ORIGIN_GROUPS, toggleGroup } from '../../src/components/FilterBar';

const group = (label: string) => ORIGIN_GROUPS.find((g) => g.label === label) ?? ORIGIN_GROUPS[0]!;

describe('origin filter chips', () => {
  it('has a chip for each origin group, GC and idle together', () => {
    expect(ORIGIN_GROUPS.map((g) => g.label)).toEqual([
      'Your code',
      'Dependencies',
      'Framework',
      'Node internals',
      'Native',
      'GC & idle',
    ]);
    expect(group('GC & idle').origins).toEqual([5, 6]);
  });

  it('hides an origin on the first toggle and shows it again on the second', () => {
    const hidden = toggleGroup([], group('Native'));
    expect(hidden).toEqual([4]);
    expect(toggleGroup(hidden, group('Native'))).toEqual([]);
  });

  it('keeps the list sorted and toggles both ids of a group', () => {
    expect(toggleGroup([4], group('GC & idle'))).toEqual([4, 5, 6]);
    expect(toggleGroup([4, 5, 6], group('GC & idle'))).toEqual([4]);
  });
});
