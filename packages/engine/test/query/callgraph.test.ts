import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { callGraph } from '../../src/query/callgraph.js';
import { DEFAULT_TRANSFORMS } from '../../src/query/types.js';
import { applyTransforms, describeFunction } from '../../src/query/view.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';
import type { ExecutionModel } from '../../src/model.js';

const fnId = (m: ExecutionModel, name: string): number =>
  Array.from({ length: m.functions.length }, (_, f) => f).find(
    (f) => m.strings[m.functions.name[f] ?? 0] === name,
  ) ?? -1;

describe('call graph on the orders server', () => {
  const m = loadModel('orders-server');
  const view = applyTransforms(m, 0, DEFAULT_TRANSFORMS);
  const graph = callGraph(m, view);
  const names = graph.nodes.map((n) => describeFunction(m, n.fn, view.syntheticPackages).name);

  it('prunes to few nodes that cover most of the time and counts the rest', () => {
    expect(graph.nodes.length).toBeLessThanOrEqual(25);
    const covered = graph.nodes.reduce((a, n) => a + n.self, 0) / graph.totalUs;
    expect(covered).toBeGreaterThanOrEqual(0.8);
    expect(graph.hiddenNodes).toBeGreaterThan(0);
  });

  it('draws the planted hot path with its edge weight and call estimate', () => {
    expect(names).toContain('lineTotal');
    const full = callGraph(m, view, { coverage: 1, maxNodes: 100 });
    const e = full.edges.find(
      (x) => x.from === fnId(m, 'buildInvoiceRows') && x.to === fnId(m, 'lineTotal'),
    );
    expect(e?.weight).toBeGreaterThan(1_800_000);
    expect(e?.count).toBeGreaterThanOrEqual(14);
    expect(e?.back).toBe(false);
  });

  it('shows hidden neighbours as +N chips and reveals them on expand', () => {
    const withHidden = graph.nodes.find((n) => n.hiddenCallers + n.hiddenCallees > 0);
    expect(withHidden).toBeDefined();
    const wide = callGraph(m, view, { expanded: [withHidden?.fn ?? 0] });
    expect(wide.nodes.length).toBeGreaterThan(graph.nodes.length);
  });

  it('centers on a function in ego mode and fades what is outside', () => {
    const ego = callGraph(m, view, { ego: fnId(m, 'buildInvoiceRows') });
    const egoNames = ego.nodes.map((n) => describeFunction(m, n.fn, view.syntheticPackages).name);
    expect(egoNames).toContain('buildInvoiceRows');
    expect(egoNames).toContain('lineTotal');
    expect(egoNames).toContain('renderInvoice');
    expect(ego.nodes.every((n) => !n.faded)).toBe(true);
    const mixed = callGraph(m, view, {
      ego: fnId(m, 'buildInvoiceRows'),
      expanded: [fnId(m, 'getOrders')],
    });
    expect(mixed.nodes.some((n) => n.faded) || mixed.nodes.length === ego.nodes.length).toBe(true);
  });

  it('marks collapsed packages and is deterministic', () => {
    const full = callGraph(m, view, { coverage: 1, maxNodes: 100 });
    expect(full.nodes.some((n) => n.isPackage)).toBe(true);
    expect(callGraph(m, view)).toEqual(graph);
  });
});

describe('call graph edge cases', () => {
  const model = analyze(
    synthCapture([
      { stack: ['top', 'a', 'b', 'a'], samples: 5 },
      { stack: ['top', 'c'], samples: 5 },
    ]),
  );
  const view = applyTransforms(model, 0, []);
  const graph = callGraph(model, view, { expanded: [fnId(model, 'a')] });

  it('shows one node per function and counts recursion instead of a self edge', () => {
    const a = graph.nodes.find((n) => n.fn === fnId(model, 'a'));
    expect(a?.total).toBe(5000);
    expect(a?.recursion).toBe(0);
    expect(graph.edges.some((e) => e.from === e.to)).toBe(false);
  });

  it('marks the edge that closes a cycle as a back edge', () => {
    const back = graph.edges.filter((e) => e.back);
    expect(back.length).toBe(1);
    expect(back[0]?.from).toBe(fnId(model, 'b'));
    expect(back[0]?.to).toBe(fnId(model, 'a'));
  });

  it('counts direct recursion', () => {
    const m = analyze(synthCapture([{ stack: ['f', 'f', 'f'], samples: 3 }]));
    const g = callGraph(m, applyTransforms(m, 0, []));
    expect(g.nodes.find((n) => n.fn === fnId(m, 'f'))?.recursion).toBe(2);
  });
});
