import { describe, expect, it } from 'vitest';
import { createQueries } from '../../src/data/queries';
import { DEFAULT_TRANSFORMS } from '../../src/state/types';
import type { N } from '../helpers/model-builder';
import { ORDERS, buildModel } from '../helpers/model-builder';

function withLineTotalSelf(self: number): N[] {
  const clone = structuredClone(ORDERS);
  const walk = (n: N): void => {
    if (n.fn === 'lineTotal') n.self = self;
    n.kids?.forEach(walk);
  };
  clone.forEach(walk);
  return clone;
}

describe('differential flame graph', () => {
  const baseline = buildModel({ roots: withLineTotalSelf(8) });
  const now = buildModel({ roots: withLineTotalSelf(40) });
  const q = createQueries(now, baseline);
  const scope = { track: 'all', transforms: [...DEFAULT_TRANSFORMS], range: null };
  const data = q.flame(scope, { sort: 'heavy', color: 'origin', zoom: [] });
  const index = (name: string): number => data.names.indexOf(name);

  it('marks a function that got slower with a positive change', () => {
    expect(data.delta?.[index('lineTotal')]).toBeGreaterThan(0.5);
  });

  it('marks work that did not grow as faster in relative terms', () => {
    expect(data.delta?.[index('fs.readFileSync')]).toBeLessThan(0);
  });

  it('leaves width from the newer run', () => {
    expect(data.w[0]).toBe(1);
  });

  it('has no change data without a baseline', () => {
    expect(
      createQueries(now).flame(scope, { sort: 'heavy', color: 'origin', zoom: [] }).delta,
    ).toBeUndefined();
  });
});
