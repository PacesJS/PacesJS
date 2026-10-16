import { describe, expect, it } from 'vitest';
import type { ExecutionModel } from '../../src/model.js';
import { relatedIds } from '../../src/query/selection.js';
import { applyTransforms, nodePath } from '../../src/query/view.js';
import { loadModel } from '../helpers/fixtures.js';

const fnId = (m: ExecutionModel, name: string): number =>
  Array.from({ length: m.functions.length }, (_, f) => f).find(
    (f) => m.strings[m.functions.name[f] ?? 0] === name,
  ) ?? -1;

describe('selection helpers on the orders server', () => {
  const m = loadModel('orders-server');
  const view = applyTransforms(m, 0, []);
  const lineTotal = fnId(m, 'lineTotal');

  it('relates a function to its nodes, spans and the tasks it ran in', () => {
    const r = relatedIds(m, view, { kind: 'function', fn: lineTotal });
    expect(r.fns).toEqual([lineTotal]);
    expect(r.nodes.length).toBe(1);
    expect(r.spans.length).toBeGreaterThanOrEqual(14);
    expect(r.tasks.length).toBeGreaterThanOrEqual(14);
  });

  it('relates a call node to itself and its subtree', () => {
    const node = view.tree.fn.indexOf(fnId(m, 'renderInvoice'));
    const r = relatedIds(m, view, { kind: 'node', path: nodePath(view.tree, node) });
    expect(r.nodes[0]).toBe(node);
    expect(r.nodes.length).toBe((view.tree.subtreeEnd[node] ?? 0) - node);
    expect(r.fns).toEqual([fnId(m, 'renderInvoice')]);
  });

  it('relates a span to its function, its node and its task', () => {
    const track = m.tracks[0];
    const span = Array.from(track?.spans.fn ?? []).indexOf(lineTotal);
    const r = relatedIds(m, view, { kind: 'span', trackIndex: 0, span });
    expect(r.fns).toEqual([lineTotal]);
    expect(r.spans).toEqual([span]);
    expect(r.tasks.length).toBe(1);
    expect(r.nodes.length).toBe(1);
    expect(view.tree.fn[r.nodes[0] ?? 0]).toBe(lineTotal);
  });

  it('relates a task to its range and its busiest functions', () => {
    const track = m.tracks[0];
    const task = Array.from(track?.tasks.busy ?? []).reduce(
      (best, v, k, all) => (v > (all[best] ?? 0) ? k : best),
      0,
    );
    const r = relatedIds(m, view, { kind: 'task', trackIndex: 0, task });
    expect(r.tasks).toEqual([task]);
    expect(r.range).toEqual([track?.tasks.start[task], track?.tasks.end[task]]);
    expect(r.fns.length).toBeLessThanOrEqual(5);
    expect(r.spans.length).toBe(
      (track?.tasks.spanEnd[task] ?? 0) - (track?.tasks.spanStart[task] ?? 0),
    );
  });

  it('relates a range to the tasks that overlap it', () => {
    const r = relatedIds(m, view, { kind: 'range', start: 1_000_000, end: 1_300_000 });
    expect(r.range).toEqual([1_000_000, 1_300_000]);
    expect(r.tasks.length).toBeGreaterThan(0);
  });

  it('returns nothing for a path that is not in the view', () => {
    const r = relatedIds(m, view, { kind: 'node', path: [99999] });
    expect(r).toEqual({ fns: [], nodes: [], spans: [], tasks: [], range: null });
  });
});
