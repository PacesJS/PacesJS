import { describe, expect, it } from 'vitest';
import { createQueries } from '../../src/data/queries';
import { DEFAULT_TRANSFORMS } from '../../src/state/types';
import { nodeElk } from '../helpers/node-elk';
import { ordersModel } from '../helpers/real-model';

const model = ordersModel();
const q = createQueries(model, null, nodeElk);
const main = model.tracks[0]?.id ?? '';
const scope = { track: main, transforms: [...DEFAULT_TRANSFORMS], range: null };

describe('queries over the real orders-server capture', () => {
  it('summarizes three tracks and findings from the engine', () => {
    const s = q.summary();
    expect(s.tracks).toHaveLength(3);
    expect(s.findings.length).toBeGreaterThan(0);
  });

  it('lists the longest GET /orders task first for the waterfall', () => {
    const tasks = q.tasks(scope);
    expect(tasks[0]?.longest).toBe(true);
    expect(tasks.some((t) => t.label === 'GET /orders')).toBe(true);
  });

  it('builds a waterfall whose first row is the task entry and whose rows nest by depth', () => {
    const w = q.waterfall(scope, -1);
    expect(w?.rows.length).toBeGreaterThan(5);
    expect(w?.rows[0]?.depth).toBe(0);
    expect(w?.rows.every((r) => r.end >= r.start)).toBe(true);
  });

  it('puts lineTotal at the top of the functions table by self time', () => {
    const rows = q.functions(scope, '').rows;
    expect(rows[0]?.name).toBe('lineTotal');
  });

  it('gives lineTotal line-level self time for the source gutter', () => {
    const lineTotal = q.functions(scope, 'lineTotal').rows[0];
    const info = q.source(scope, lineTotal?.fn ?? 0);
    expect(info?.lineSelf.length).toBeGreaterThan(0);
    expect(info?.path).toMatch(/money|invoice|src/);
  });

  it('draws a flame graph whose root covers all kept samples', () => {
    const f = q.flame(scope, { sort: 'heavy', color: 'origin', zoom: [] });
    expect(f.length).toBeGreaterThan(10);
    expect(f.w[0]).toBe(1);
  });

  it('lays out a call graph with a position per node', async () => {
    const g = await q.callGraph(scope, { all: false, reveal: [] }, []);
    expect(g.graph.nodes.length).toBeGreaterThan(3);
    expect(g.layout.nodes).toHaveLength(g.graph.nodes.length);
  });

  it('builds an overview lane per track with CPU bins and tasks', () => {
    const o = q.overview();
    expect(o.lanes).toHaveLength(3);
    expect(o.lanes[0]?.taskStart.length).toBeGreaterThan(10);
    expect(Math.max(...(o.lanes[0]?.cpu ?? []))).toBeGreaterThan(0);
  });

  it('restricts every query to the range', () => {
    const w = q.functions({ ...scope, range: [394_000, 594_000] }, '');
    const all = q.functions(scope, '');
    expect(w.rows.reduce((a, r) => a + r.selfUs, 0)).toBeLessThan(
      all.rows.reduce((a, r) => a + r.selfUs, 0),
    );
  });
});
