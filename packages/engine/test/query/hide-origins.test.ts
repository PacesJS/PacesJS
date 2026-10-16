import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { Origin } from '../../src/model.js';
import type { ExecutionModel } from '../../src/model.js';
import { callGraph } from '../../src/query/callgraph.js';
import { flameLayout } from '../../src/query/flame.js';
import { functionRows } from '../../src/query/functions.js';
import { applyTransforms, describeFunction } from '../../src/query/view.js';
import type { TransformedView } from '../../src/query/types.js';
import { DEFAULT_TRANSFORMS } from '../../src/query/types.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';

const originOfNode = (m: ExecutionModel, v: TransformedView, n: number): number =>
  describeFunction(m, v.tree.fn[n] ?? 0, v.syntheticPackages).origin;

const selfByName = (m: ExecutionModel, v: TransformedView, name: string): number => {
  let sum = 0;
  for (let n = 0; n < v.tree.length; n++) {
    if (describeFunction(m, v.tree.fn[n] ?? 0, v.syntheticPackages).name === name) {
      sum += v.tree.self[n] ?? 0;
    }
  }
  return sum;
};

describe('hide-origins on a synthetic stack', () => {
  const dep = 'file:///project/node_modules/lib/index.js';
  const m = analyze(
    synthCapture(
      [
        { stack: ['app', { name: 'libWork', url: dep }, 'inner'], samples: 6 },
        { stack: ['app', { name: 'libWork', url: dep }], samples: 4 },
        { stack: ['app'], samples: 2 },
      ],
      { argv: ['node', '/project/src/app.js'] },
    ),
  );

  it('merges hidden frames into the nearest kept caller and moves their self time up', () => {
    const view = applyTransforms(m, 0, [{ kind: 'hide-origins', origins: [Origin.Dependency] }]);
    const names = Array.from(view.tree.fn, (f) => describeFunction(m, f).name);
    expect(names).toEqual(['(root)', 'app', 'inner']);
    expect(selfByName(m, view, 'app')).toBeCloseTo(6000, -2);
    expect(selfByName(m, view, 'inner')).toBeCloseTo(6000, -2);
  });

  it('keeps the total time', () => {
    const before = applyTransforms(m, 0, []);
    const after = applyTransforms(m, 0, [{ kind: 'hide-origins', origins: [Origin.Dependency] }]);
    expect(after.totalUs).toBeCloseTo(before.totalUs, 3);
  });

  it('never hides the root, even when every origin is hidden', () => {
    const all = [
      Origin.User,
      Origin.Dependency,
      Origin.Framework,
      Origin.Node,
      Origin.Native,
      Origin.Idle,
      Origin.Gc,
    ];
    const view = applyTransforms(m, 0, [{ kind: 'hide-origins', origins: all }]);
    expect(view.tree.length).toBe(1);
    expect(view.tree.self[0]).toBeCloseTo(view.totalUs, 3);
  });

  it('hides collapsed package nodes when applied after collapse-dependencies', () => {
    const view = applyTransforms(m, 0, [
      { kind: 'collapse-dependencies' },
      { kind: 'hide-origins', origins: [Origin.Dependency] },
    ]);
    expect(view.tree.fn.every((f) => f < m.functions.length)).toBe(true);
    expect(selfByName(m, view, 'app')).toBeCloseTo(6000, -2);
  });

  it('serializes as plain data', () => {
    const t = { kind: 'hide-origins', origins: [Origin.Gc, Origin.Native] } as const;
    expect(JSON.parse(JSON.stringify(t))).toEqual(t);
  });
});

describe('hide-origins on the eslint cli', () => {
  const m = loadModel('eslint-cli');
  const t = m.primaryTrack;
  const plain = applyTransforms(m, t, [...DEFAULT_TRANSFORMS]);
  const hidden = applyTransforms(m, t, [
    ...DEFAULT_TRANSFORMS,
    {
      kind: 'hide-origins',
      origins: [Origin.Dependency, Origin.Node, Origin.Native, Origin.Gc],
    },
  ]);

  it('leaves only the target code in the view', () => {
    const origins = new Set<number>();
    for (let n = 1; n < hidden.tree.length; n++) origins.add(originOfNode(m, hidden, n));
    expect([...origins]).toEqual([Origin.User]);
  });

  it('keeps the whole time and gives the target code the hidden time as self time', () => {
    expect(hidden.totalUs).toBeCloseTo(plain.totalUs, 3);
    const userSelf = (v: TransformedView) => {
      let sum = 0;
      for (let n = 1; n < v.tree.length; n++) {
        if (originOfNode(m, v, n) === Origin.User) sum += v.tree.self[n] ?? 0;
      }
      return sum;
    };
    expect(userSelf(hidden)).toBeGreaterThan(userSelf(plain) * 1.5);
  });

  it('is honored by the flame graph, the functions table and the call graph', () => {
    const flame = flameLayout(m, hidden);
    expect(Array.from(flame.origin).filter((o, i) => i > 0 && o !== Origin.User)).toEqual([]);
    expect(functionRows(m, hidden).every((r) => r.origin === Origin.User)).toBe(true);
    expect(callGraph(m, hidden).nodes.length).toBeGreaterThan(2);
    expect(
      callGraph(m, hidden).nodes.every((n) => describeFunction(m, n.fn).origin === Origin.User),
    ).toBe(true);
  });
});

describe('functionRows filters', () => {
  const m = loadModel('eslint-cli');
  const view = applyTransforms(m, m.primaryTrack, [...DEFAULT_TRANSFORMS]);

  it('filters by origin', () => {
    const rows = functionRows(m, view, { origins: [Origin.User] });
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.every((r) => r.origin === Origin.User)).toBe(true);
  });

  it('filters by package, including a collapsed package row', () => {
    const own = functionRows(m, view, { pkg: 'eslint' });
    expect(own.length).toBeGreaterThan(20);
    expect(own.every((r) => r.pkg === 'eslint')).toBe(true);
    const ts = functionRows(m, view, { pkg: 'typescript' });
    expect(ts.map((r) => r.name)).toEqual(['typescript']);
  });

  it('combines both filters', () => {
    expect(functionRows(m, view, { pkg: 'eslint', origins: [Origin.Dependency] })).toEqual([]);
  });
});
