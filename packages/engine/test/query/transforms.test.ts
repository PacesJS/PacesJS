import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { Origin } from '../../src/model.js';
import type { ExecutionModel } from '../../src/model.js';
import { DEFAULT_TRANSFORMS } from '../../src/query/types.js';
import type { TransformedView } from '../../src/query/types.js';
import { applyTransforms, describeFunction, findNode, nodePath } from '../../src/query/view.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';

const fnId = (m: ExecutionModel, name: string): number =>
  Array.from({ length: m.functions.length }, (_, f) => f).find(
    (f) => m.strings[m.functions.name[f] ?? 0] === name,
  ) ?? -1;

const names = (m: ExecutionModel, v: TransformedView): string[] =>
  Array.from(v.tree.fn, (f) => describeFunction(m, f, v.syntheticPackages).name);

const selfOf = (m: ExecutionModel, v: TransformedView, name: string): number => {
  let total = 0;
  for (let i = 0; i < v.tree.length; i++) {
    if (describeFunction(m, v.tree.fn[i] ?? 0, v.syntheticPackages).name === name) {
      total += v.tree.self[i] ?? 0;
    }
  }
  return total;
};

const totalOfRoot = (v: TransformedView): number => v.tree.total[0] ?? 0;

describe('transforms on the orders server', () => {
  const m = loadModel('orders-server');
  const base = applyTransforms(m, 0, []);
  const lineTotal = fnId(m, 'lineTotal');

  it('returns the track itself for an empty stack', () => {
    expect(base.tree).toBe(m.tracks[0]?.callTree);
    expect(base.totalUs).toBeCloseTo(m.tracks[0]?.callTree.total[0] ?? 0, 3);
  });

  it('merges a function everywhere and gives its self time to its callers', () => {
    const before = selfOf(m, base, 'buildInvoiceRows');
    const v = applyTransforms(m, 0, [{ kind: 'merge-function', fn: lineTotal }]);
    expect(names(m, v)).not.toContain('lineTotal');
    expect(selfOf(m, v, 'buildInvoiceRows')).toBeCloseTo(before + selfOf(m, base, 'lineTotal'), 3);
    expect(totalOfRoot(v)).toBeCloseTo(totalOfRoot(base), 3);
  });

  it('keeps one call node and its descendants when focusing on a subtree', () => {
    const node = Array.from({ length: base.tree.length }, (_, i) => i).find(
      (i) => base.tree.fn[i] === fnId(m, 'renderInvoice'),
    );
    const v = applyTransforms(m, 0, [
      { kind: 'focus-subtree', path: nodePath(base.tree, node ?? 0) },
    ]);
    expect(describeFunction(m, v.tree.fn[1] ?? 0).name).toBe('renderInvoice');
    expect(totalOfRoot(v)).toBeCloseTo(base.tree.total[node ?? 0] ?? 0, 3);
    expect(v.tree.depth[1]).toBe(1);
  });

  it('keeps every subtree rooted at a function, merged, when focusing on a function', () => {
    const v = applyTransforms(m, 0, [{ kind: 'focus-function', fn: fnId(m, 'loadTemplate') }]);
    expect(names(m, v).slice(0, 3)).toEqual(['(root)', 'loadTemplate', 'readFileSync']);
    expect(totalOfRoot(v)).toBeGreaterThan(250_000);
    expect(totalOfRoot(v)).toBeLessThan(300_000);
  });

  it('keeps only samples where the function is the innermost frame when focusing on self', () => {
    const v = applyTransforms(m, 0, [{ kind: 'focus-function-self', fn: lineTotal }]);
    expect(totalOfRoot(v)).toBeCloseTo(selfOf(m, base, 'lineTotal'), 3);
    expect(selfOf(m, v, 'lineTotal')).toBeCloseTo(totalOfRoot(v), 3);
  });

  it('folds all frames of an npm package into one node', () => {
    const v = applyTransforms(m, 0, [{ kind: 'collapse-package', pkg: 'ajv' }]);
    expect(v.syntheticPackages).toEqual(['ajv']);
    const synthetic = names(m, v).filter((n) => n === 'ajv');
    expect(synthetic.length).toBeGreaterThan(0);
    expect(names(m, v)).not.toContain('validateFunctionCode');
    expect(totalOfRoot(v)).toBeCloseTo(totalOfRoot(base), 3);
    expect(v.tree.fn.some((f) => f >= m.functions.length)).toBe(true);
  });

  it('removes samples that contain a function', () => {
    const v = applyTransforms(m, 0, [{ kind: 'drop-samples', fn: fnId(m, 'loadTemplate') }]);
    expect(names(m, v)).not.toContain('loadTemplate');
    expect(totalOfRoot(v)).toBeLessThan(totalOfRoot(base) - 250_000);
  });

  it('restricts everything to a time range', () => {
    const start = 1_000_000;
    const end = 1_500_000;
    const v = applyTransforms(m, 0, [{ kind: 'time-range', start, end }]);
    expect(v.samples.length).toBeGreaterThan(100);
    expect(Math.min(...v.samples.time)).toBeGreaterThanOrEqual(start);
    expect(Math.max(...v.samples.time)).toBeLessThan(end);
    expect(totalOfRoot(v)).toBeCloseTo(
      v.samples.dur.reduce((a, b) => a + b, 0),
      3,
    );
  });

  it('builds the tree from the leaves up so self time sits at the roots', () => {
    const v = applyTransforms(m, 0, [{ kind: 'invert' }]);
    expect(v.inverted).toBe(true);
    const rootChildren = Array.from({ length: v.tree.length }, (_, i) => i).filter(
      (i) => v.tree.parent[i] === 0,
    );
    const top = rootChildren.reduce((a, b) =>
      (v.tree.total[b] ?? 0) > (v.tree.total[a] ?? 0) ? b : a,
    );
    expect(describeFunction(m, v.tree.fn[top] ?? 0).name).toBe('lineTotal');
    expect(v.tree.total[top]).toBeCloseTo(selfOf(m, base, 'lineTotal'), 3);
    expect(totalOfRoot(v)).toBeCloseTo(totalOfRoot(base), 3);
  });

  it('applies the default stack: dependencies collapsed, plumbing merged, idle dropped', () => {
    const v = applyTransforms(m, 0, DEFAULT_TRANSFORMS);
    const infos = Array.from(new Set(v.tree.fn), (f) =>
      describeFunction(m, f, v.syntheticPackages),
    );
    expect(infos.some((i) => i.origin === Origin.Idle)).toBe(false);
    expect(infos.some((i) => i.plumbing)).toBe(false);
    expect(infos.some((i) => i.synthetic && i.name === 'ajv')).toBe(true);
    expect(totalOfRoot(v)).toBeCloseTo(m.tracks[0]?.busyUs ?? 0, 0);
  });

  it('is deterministic', () => {
    const a = applyTransforms(m, 0, DEFAULT_TRANSFORMS);
    const b = applyTransforms(m, 0, DEFAULT_TRANSFORMS);
    expect(Array.from(a.tree.fn)).toEqual(Array.from(b.tree.fn));
    expect(Array.from(a.samples.node)).toEqual(Array.from(b.samples.node));
  });

  it('throws a clear error for a track that does not exist', () => {
    expect(() => applyTransforms(m, 9, [])).toThrow(/No track at index 9/);
  });
});

describe('transforms on small synthetic trees', () => {
  const model = analyze(
    synthCapture([
      { stack: ['top', 'f', 'g', 'f', 'g', 'leaf'], samples: 4 },
      { stack: ['top', 'f', 'leaf'], samples: 2 },
      { stack: ['top', 'other', 'g'], samples: 3 },
    ]),
  );
  const f = fnId(model, 'f');
  const g = fnId(model, 'g');

  it('collapses indirect recursion into the outermost call', () => {
    const v = applyTransforms(model, 0, [{ kind: 'collapse-recursion', fn: f }]);
    expect(names(model, v).filter((n) => n === 'f').length).toBe(1);
    const fNode = names(model, v).indexOf('f');
    expect(v.tree.total[fNode]).toBe(6000);
    expect(totalOfRoot(v)).toBe(9000);
  });

  it('merges one call node only and leaves other calls of the function alone', () => {
    const v = applyTransforms(model, 0, [
      { kind: 'merge-node', path: [fnId(model, 'top'), fnId(model, 'other'), g] },
    ]);
    expect(names(model, v).filter((n) => n === 'g').length).toBe(2);
    const other = names(model, v).indexOf('other');
    expect(v.tree.self[other]).toBe(3000);
  });

  it('finds nodes by path', () => {
    const base = applyTransforms(model, 0, []);
    const node = findNode(base.tree, [fnId(model, 'top'), f]);
    expect(node).toBeGreaterThan(0);
    expect(nodePath(base.tree, node)).toEqual([fnId(model, 'top'), f]);
    expect(findNode(base.tree, [999])).toBe(-1);
  });
});
