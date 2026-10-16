import { describe, expect, it } from 'vitest';
import type { ExecutionModel } from '../../src/model.js';
import { DEFAULT_TRANSFORMS } from '../../src/query/types.js';
import type { TransformedView } from '../../src/query/types.js';
import { applyTransforms, describeFunction } from '../../src/query/view.js';
import { loadModel } from '../helpers/fixtures.js';
import type { FixtureName } from '../helpers/fixtures.js';

const nameAt = (m: ExecutionModel, v: TransformedView, n: number) =>
  describeFunction(m, v.tree.fn[n] ?? 0, v.syntheticPackages).name;

/** Names from the entry root down to `n`. */
const pathTo = (m: ExecutionModel, v: TransformedView, n: number): string[] => {
  const out: string[] = [];
  for (let a = n; a > 0; a = v.tree.parent[a] ?? 0) out.push(nameAt(m, v, a));
  return out.reverse();
};

const nodesNamed = (m: ExecutionModel, v: TransformedView, name: string): number[] => {
  const out: number[] = [];
  for (let n = 1; n < v.tree.length; n++) if (nameAt(m, v, n) === name) out.push(n);
  return out;
};

describe('async-chain: main awaits run awaits readAndVerify', () => {
  const m = loadModel('async-chain');
  const t = m.tracks[m.primaryTrack];
  const view = applyTransforms(m, m.primaryTrack, DEFAULT_TRANSFORMS);

  it('stitches the continuation after every await', () => {
    expect(t?.continuations.length).toBeGreaterThanOrEqual(4);
    expect(Array.from(t?.continuations.stitch ?? []).every((s) => s === 1)).toBe(true);
  });

  it('shows both segments of readAndVerify under the same parent, run', () => {
    const nodes = nodesNamed(m, view, 'readAndVerify');
    expect(nodes).toHaveLength(1);
    const p = pathTo(m, view, nodes[0] ?? 0);
    expect(p.slice(-3)).toEqual(['main', 'run', 'readAndVerify']);
    const kids = nodesNamed(m, view, 'prepare').concat(nodesNamed(m, view, 'verify'));
    expect(kids.map((k) => view.tree.parent[k])).toEqual([nodes[0], nodes[0]]);
  });

  it('puts the reporter under run, the function that awaited', () => {
    const [reporter] = nodesNamed(m, view, 'reporter');
    expect(pathTo(m, view, reporter ?? 0).slice(-3)).toEqual(['main', 'run', 'reporter']);
  });

  it('roots everything at the entry script', () => {
    expect(nameAt(m, view, 1)).toBe('zoo/apps/async-chain.cjs');
    expect(m.tracks[m.primaryTrack]?.rootFn).toBe(view.tree.fn[1]);
  });

  it('keeps the total time of the run', () => {
    const plain = applyTransforms(m, m.primaryTrack, [{ kind: 'drop-idle' }]);
    expect(view.totalUs).toBeCloseTo(plain.totalUs, 3);
  });

  it('without the transform the continuations are roots of their own', () => {
    const off = applyTransforms(
      m,
      m.primaryTrack,
      DEFAULT_TRANSFORMS.filter((x) => x.kind !== 'stitch-continuations'),
    );
    const roots = nodesNamed(m, off, 'readAndVerify').filter((n) => (off.tree.depth[n] ?? 0) <= 2);
    expect(roots.length).toBeGreaterThan(0);
  });
});

describe.each(['eslint-cli', 'eslint-cli-wrapped'] as FixtureName[])('%s', (name) => {
  const m = loadModel(name);
  const t = m.tracks[m.primaryTrack];
  const view = applyTransforms(m, m.primaryTrack, DEFAULT_TRANSFORMS);

  it('does not leave readAndVerifyFile as a root: it sits under the logical chain', () => {
    const nodes = nodesNamed(m, view, 'readAndVerifyFile');
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) {
      const p = pathTo(m, view, n);
      expect(p.length).toBeGreaterThan(3);
      expect(p).toContain('lintFiles');
    }
  });

  it('stitches some continuation tasks and reports the rest as unstitched, not as errors', () => {
    const stitched = Array.from(t?.tasks.stitch ?? []).filter((s) => s > 0).length;
    expect(stitched).toBeGreaterThanOrEqual(1);
    expect(stitched).toBeLessThan(t?.tasks.length ?? 0);
  });

  it('starts every view at the entry script', () => {
    expect(nameAt(m, view, 1)).toBe('eslint/bin/eslint.js');
    for (let c = 1; c < view.tree.length; c = view.tree.subtreeEnd[c] ?? c + 1) {
      expect(view.tree.parent[c]).toBe(0);
      expect(c).toBe(1);
    }
  });
});
