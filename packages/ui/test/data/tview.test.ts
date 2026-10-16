import { describe, expect, it } from 'vitest';
import { buildTView, functionTotals, viewFnName } from '../../src/data/tview';
import type { TView } from '../../src/data/tview';
import { DEFAULT_TRANSFORMS } from '../../src/state/types';
import type { Transform } from '../../src/state/types';
import { ORDERS, buildModel } from '../helpers/model-builder';

const model = buildModel({ roots: ORDERS });
const track = model.tracks[0]!;

function view(transforms: readonly Transform[], range: [number, number] | null = null): TView {
  return buildTView({ model, tracks: [track], transforms, range });
}
const names = (t: TView): string[] =>
  Array.from({ length: t.length }, (_, i) => viewFnName(model, t, t.fn[i] ?? 0));
const find = (t: TView, name: string): number => names(t).indexOf(name);

describe('transformed call tree', () => {
  it('keeps every sample when no transform is applied', () => {
    const t = view([]);
    expect(t.keptUs).toBe(121_000);
    expect(t.total[0]).toBe(t.keptUs);
  });

  it('orders children heaviest first', () => {
    const t = view([]);
    const root = 0;
    const kids: string[] = [];
    for (let c = root + 1; c < (t.subtreeEnd[root] ?? 0); c = t.subtreeEnd[c] ?? c + 1) {
      kids.push(viewFnName(model, t, t.fn[c] ?? 0));
    }
    expect(kids[0]).toBe('GET /orders');
  });

  it('collapses dependency packages into one node named after the package', () => {
    const t = view([{ k: 'collapse-deps' }]);
    expect(names(t)).toContain('ajv');
    expect(names(t)).not.toContain('validateStep');
  });

  it('sums the collapsed frames into the package node', () => {
    const t = view([{ k: 'collapse-deps' }]);
    const ajv = find(t, 'ajv');
    expect(t.total[ajv]).toBe(15_000);
  });

  it('merges a function into its callers, handing over its self time', () => {
    const fn = model.strings.indexOf('loadTemplate');
    const id = Array.from(model.functions.name).findIndex((n) => n === fn);
    const before = view([]);
    const after = view([{ k: 'merge-fn', fn: id }]);
    expect(names(after)).not.toContain('loadTemplate');
    const render = (t: TView) => t.self[find(t, 'renderInvoice')];
    expect(render(after)).toBe((render(before) ?? 0) + 9_000);
  });

  it('focuses on a function and drops stacks without it', () => {
    const id = Array.from(model.functions.name).findIndex(
      (n) => n === model.strings.indexOf('buildInvoiceRows'),
    );
    const t = view([{ k: 'focus-fn', fn: id }]);
    expect(names(t)[0]).toBe('buildInvoiceRows');
    expect(names(t)).not.toContain('flushMetrics');
  });

  it('restricts to a time range', () => {
    const task0 = track.tasks.end[0] ?? 0;
    const t = view([], [0, task0]);
    expect(names(t)).not.toContain('flushMetrics');
  });

  it('inverts the tree so self time sits at the roots', () => {
    const t = view([{ k: 'invert' }]);
    expect(viewFnName(model, t, t.fn[0] ?? 0)).toBe('fs.readFileSync');
  });

  it('applies the default stack without losing user functions', () => {
    const t = view(DEFAULT_TRANSFORMS);
    expect(names(t)).toContain('lineTotal');
  });

  it('counts a recursive function once in its total', () => {
    const rec = buildModel({
      roots: [{ fn: 'a', self: 1, kids: [{ fn: 'a', self: 1, kids: [{ fn: 'a', self: 3 }] }] }],
    });
    const t = buildTView({ model: rec, tracks: rec.tracks, transforms: [], range: null });
    const totals = functionTotals(t);
    const a = Array.from(rec.functions.name).findIndex((n) => n === rec.strings.indexOf('a'));
    expect(totals.total[a]).toBe(5_000);
    expect(totals.self[a]).toBe(5_000);
  });
});
