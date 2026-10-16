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

describe('call graph roots and connectivity', () => {
  const argv = ['node', '/project/src/app.js'];
  const m = analyze(
    synthCapture(
      [
        { stack: ['main', 'mid1', 'mid2', 'leaf'], samples: 50 },
        { stack: ['main', 'other'], samples: 5 },
        { stack: ['main'], samples: 1 },
        { stack: ['main', 'mid1'], samples: 1 },
        { stack: ['main', 'mid1', 'mid2'], samples: 1 },
      ],
      { argv },
    ),
  );
  const view = applyTransforms(m, 0, DEFAULT_TRANSFORMS);
  const graph = callGraph(m, view, { maxNodes: 2, coverage: 1 });
  const name = (fn: number) => describeFunction(m, fn, view.syntheticPackages).name;

  it('shows the entry root at the top, above everything else', () => {
    expect(graph.nodes[0]?.isEntry).toBe(true);
    expect(name(graph.nodes[0]?.fn ?? 0)).toBe('src/app.js');
    expect(graph.nodes.filter((n) => n.isEntry)).toHaveLength(1);
    expect(graph.nodes[0]?.totalShare).toBeCloseTo(1, 2);
  });

  it('contracts pruned frames into an edge from the nearest kept ancestor', () => {
    const edges = graph.edges.map((e) => `${name(e.from)}>${name(e.to)}:${e.hiddenFrames}`);
    expect(edges.sort()).toEqual(['src/app.js>leaf:3', 'src/app.js>other:1']);
  });

  it('never leaves a kept node without a caller, except the entry', () => {
    const called = new Set(graph.edges.map((e) => e.to));
    const orphans = graph.nodes.filter((n) => !n.isEntry && !called.has(n.fn));
    expect(orphans).toEqual([]);
  });

  it('carries the time of the contracted path as the edge weight', () => {
    const e = graph.edges.find((x) => name(x.to) === 'leaf');
    expect(e?.weight).toBeCloseTo(50_000, -2);
  });

  it('draws direct calls with no hidden frames', () => {
    const full = callGraph(m, view, { coverage: 1, maxNodes: 100 });
    expect(full.edges.every((e) => e.hiddenFrames === 0)).toBe(true);
  });

  it('shows recursion as a count on the node, not as a self edge', () => {
    const rec = analyze(
      synthCapture(
        [
          { stack: ['main', 'rec', 'rec', 'rec', 'work'], samples: 5 },
          { stack: ['main', 'rec', 'rec'], samples: 5 },
        ],
        { argv },
      ),
    );
    const v = applyTransforms(rec, 0, DEFAULT_TRANSFORMS);
    const g = callGraph(rec, v, { coverage: 1 });
    expect(g.edges.filter((e) => e.from === e.to)).toEqual([]);
    expect(g.nodes.find((n) => describeFunction(rec, n.fn).name === 'rec')?.recursion).toBe(2);
  });

  it('keeps the contracted graph connected on a real profile', () => {
    const e = loadModel('eslint-cli');
    const ev = applyTransforms(e, e.primaryTrack, DEFAULT_TRANSFORMS);
    const g = callGraph(e, ev);
    const called = new Set(g.edges.map((x) => x.to));
    expect(g.nodes.filter((n) => !n.isEntry && !called.has(n.fn))).toEqual([]);
    expect(g.nodes[0]?.isEntry).toBe(true);
  });

  it('has no entry node without the stitched root', () => {
    const plain = applyTransforms(m, 0, [{ kind: 'drop-idle' }]);
    expect(callGraph(m, plain).nodes.some((n) => n.isEntry)).toBe(false);
  });
});

describe('call graph prioritizes the target code', () => {
  const m = loadModel('eslint-cli');
  const view = applyTransforms(m, m.primaryTrack, DEFAULT_TRANSFORMS);
  const isUser = (fn: number) => fn < m.functions.length && m.functions.origin[fn] === 0;

  it('keeps target functions that matter and caps the graph at about 40 nodes', () => {
    const g = callGraph(m, view);
    const users = g.nodes.filter((n) => isUser(n.fn) && !n.isEntry);
    const old = callGraph(m, view, { prioritizeTarget: false });
    expect(users.length).toBeGreaterThan(
      old.nodes.filter((n) => isUser(n.fn) && !n.isEntry).length,
    );
    expect(g.nodes.length).toBeLessThanOrEqual(41);
    expect(g.nodes[0]?.isEntry).toBe(true);
  });

  it('keeps every target function above the share thresholds', () => {
    const g = callGraph(m, view, { maxNodes: 100 });
    const shown = new Set(g.nodes.map((n) => n.fn));
    for (const n of callGraph(m, view, { coverage: 1, maxNodes: 1000, prioritizeTarget: false })
      .nodes) {
      if (isUser(n.fn) && (n.totalShare >= 0.01 || n.selfShare >= 0.005))
        expect(shown.has(n.fn)).toBe(true);
    }
  });

  it('keeps the contracted edges connected', () => {
    const g = callGraph(m, view);
    const called = new Set(g.edges.map((e) => e.to));
    expect(g.nodes.filter((n) => !n.isEntry && !called.has(n.fn))).toEqual([]);
  });

  it('can be turned off', () => {
    expect(callGraph(m, view, { prioritizeTarget: false }).nodes.length).toBeLessThanOrEqual(26);
  });
});
