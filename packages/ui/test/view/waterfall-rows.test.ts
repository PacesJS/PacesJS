import { describe, expect, it } from 'vitest';
import { createQueries } from '../../src/data/queries';
import { DEFAULT_TRANSFORMS } from '../../src/state/types';
import { visibleRows } from '../../src/view/waterfall-rows';
import { ordersModel } from '../helpers/real-model';

const model = ordersModel();
const scope = {
  track: model.tracks[0]?.id ?? '',
  transforms: [...DEFAULT_TRANSFORMS],
  range: null,
  hide: [],
};
const wf = createQueries(model).waterfall(scope, -1, { sort: 'time', minDurUs: 0 });
const rows = wf?.rows ?? [];

describe('visible waterfall rows', () => {
  it('shows every row when nothing is collapsed', () => {
    expect(visibleRows(rows, new Set())).toHaveLength(rows.length);
  });

  it('hides the rows under a collapsed parent', () => {
    const parent = rows.findIndex((r) => r.name === 'getOrders');
    expect(visibleRows(rows, new Set([rows[parent]?.id ?? -1]))).toHaveLength(parent + 1);
  });

  it('collapses everything except the critical chain in path-only mode', () => {
    const visible = visibleRows(rows, new Set(), wf?.criticalRows ?? []);
    expect(visible).toEqual(wf?.criticalRows);
    expect(visible.length).toBeLessThan(rows.length);
  });

  it('keeps the task row first in path-only mode', () => {
    const visible = visibleRows(rows, new Set(), wf?.criticalRows ?? []);
    expect(rows[visible[0] ?? -1]?.kind).toBe('task');
  });
});
