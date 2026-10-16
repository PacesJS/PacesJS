import { describe, expect, it } from 'vitest';
import { Origin } from '../../src/model.js';
import type { ExecutionModel } from '../../src/model.js';
import { functionRows, sandwich } from '../../src/query/functions.js';
import { DEFAULT_TRANSFORMS } from '../../src/query/types.js';
import { applyTransforms, describeFunction } from '../../src/query/view.js';
import { loadModel } from '../helpers/fixtures.js';

const fnId = (m: ExecutionModel, name: string): number =>
  Array.from({ length: m.functions.length }, (_, f) => f).find(
    (f) => m.strings[m.functions.name[f] ?? 0] === name,
  ) ?? -1;

describe('functions table on the orders server', () => {
  const m = loadModel('orders-server');
  const view = applyTransforms(m, 0, DEFAULT_TRANSFORMS);

  it('sorts by self time with user code first', () => {
    const rows = functionRows(m, view);
    expect(rows[0]?.name).toBe('lineTotal');
    expect(rows[0]?.origin).toBe(Origin.User);
    const firstNonUser = rows.findIndex((r) => r.origin !== Origin.User);
    expect(rows.slice(firstNonUser).some((r) => r.origin === Origin.User)).toBe(false);
  });

  it('can ignore the user-first grouping', () => {
    const rows = functionRows(m, view, { userFirst: false });
    for (let i = 1; i < rows.length; i++)
      expect(rows[i - 1]?.self ?? 0).toBeGreaterThanOrEqual(rows[i]?.self ?? 0);
  });

  it('reports shares, totals and estimated calls', () => {
    const row = functionRows(m, view).find((r) => r.name === 'getOrders');
    expect(row?.totalShare).toBeGreaterThan(0.5);
    expect(row?.calls).toBeGreaterThanOrEqual(14);
    expect(row?.file).toBe('zoo/orders-server/src/routes/orders.ts');
  });

  it('searches name, file and package case-insensitively', () => {
    expect(
      functionRows(m, view, { search: 'MONEY.TS' })
        .map((r) => r.name)
        .sort(),
    ).toEqual(['formatCurrency', 'lineTotal']);
    expect(
      functionRows(m, view, { search: 'ajv' }).every((r) =>
        `${r.name} ${r.file} ${r.pkg}`.toLowerCase().includes('ajv'),
      ),
    ).toBe(true);
  });

  it('sorts text keys ascending by default and honors direction', () => {
    const asc = functionRows(m, view, { sort: 'name', userFirst: false }).map((r) => r.name);
    expect(asc).toEqual([...asc].sort());
    const desc = functionRows(m, view, { sort: 'name', direction: 'desc', userFirst: false }).map(
      (r) => r.name,
    );
    expect(desc).toEqual([...asc].reverse());
  });

  it('hides idle and gc rows unless asked', () => {
    const raw = applyTransforms(m, 0, []);
    const names = (include: boolean) =>
      functionRows(m, raw, { includeIdle: include }).map((r) => r.name);
    expect(names(false)).not.toContain('(idle)');
    expect(names(true)).toContain('(idle)');
  });
});

describe('sandwich on the orders server', () => {
  const m = loadModel('orders-server');
  const view = applyTransforms(m, 0, DEFAULT_TRANSFORMS);
  const fn = fnId(m, 'buildInvoiceRows');
  const s = sandwich(m, view, fn);
  const name = (layout: typeof s.callers, i: number) => describeFunction(m, layout.fn[i] ?? 0).name;

  it('lists callees below the function', () => {
    expect(name(s.callees, 0)).toBe('(root)');
    expect(name(s.callees, 1)).toBe('buildInvoiceRows');
    const kids = Array.from({ length: s.callees.length }, (_, i) => i)
      .filter((i) => s.callees.depth[i] === 2)
      .map((i) => name(s.callees, i));
    expect(kids).toContain('lineTotal');
  });

  it('lists callers inverted above the function', () => {
    const chain = Array.from({ length: s.callers.length }, (_, i) => name(s.callers, i));
    expect(chain.slice(1, 4)).toEqual(['buildInvoiceRows', 'renderInvoice', 'getOrders']);
  });

  it('weights both sides by the function total time', () => {
    const total = view.tree.total[Array.from(view.tree.fn).indexOf(fn)] ?? 0;
    expect(s.callees.total[1]).toBeCloseTo(total, 3);
    expect(s.callers.total[1]).toBeCloseTo(total, 3);
  });

  it('returns just the root for a function that is not in the view', () => {
    expect(sandwich(m, view, fnId(m, 'crunch')).callees.length).toBe(1);
  });
});
