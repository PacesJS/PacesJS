import { describe, expect, it } from 'vitest';
import { createQueries } from '../../src/data/queries';
import { DEFAULT_TRANSFORMS } from '../../src/state/types';
import { nodeElk } from '../helpers/node-elk';
import { fixtureModel, ordersModel } from '../helpers/real-model';

const head = ordersModel();
const scope = {
  track: head.tracks[0]?.id ?? '',
  transforms: [...DEFAULT_TRANSFORMS],
  range: null,
  hide: [],
};
const opts = {
  sort: 'heavy' as const,
  color: 'origin' as const,
  zoom: [] as number[],
  zoomPath: [] as number[],
};
const indexOf = (names: string[], name: string): number => names.indexOf(name);

describe('differential flame graph', () => {
  const against = (base: string) =>
    createQueries(head, fixtureModel(base), nodeElk).flame(scope, opts);

  it('marks work absent from the baseline as slower', () => {
    const data = against('sync-io');
    expect(data.delta?.[indexOf(data.names, 'lineTotal')]).toBeGreaterThan(0);
  });

  it('shows no change against the same run', () => {
    const data = against('orders-server');
    expect(Math.max(...(data.delta ?? [1]).map(Math.abs))).toBe(0);
  });

  it('keeps width from the newer run', () => {
    expect(against('sync-io').w[0]).toBe(1);
  });

  it('has no change data without a baseline', () => {
    expect(createQueries(head, null, nodeElk).flame(scope, opts).delta).toBeUndefined();
  });
});
