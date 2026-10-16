import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import type { ModelDiff } from '../../src/query/types.js';
import { DEFAULT_TRANSFORMS } from '../../src/query/types.js';
import { flameLayout } from '../../src/query/flame.js';
import { applyTransforms, describeFunction } from '../../src/query/view.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';

describe('flame graph on the orders server', () => {
  const m = loadModel('orders-server');
  const view = applyTransforms(m, 0, DEFAULT_TRANSFORMS);
  const layout = flameLayout(m, view);
  const nameAt = (i: number) => describeFunction(m, layout.fn[i] ?? 0, view.syntheticPackages).name;

  it('lays the root out at full width and children inside their parent', () => {
    expect(layout.x[0]).toBe(0);
    expect(layout.w[0]).toBe(1);
    expect(layout.totalUs).toBeCloseTo(view.totalUs, 3);
    const bad = Array.from({ length: layout.length }, (_, i) => i).filter((i) => {
      const p = view.tree.parent[layout.node[i] ?? 0] ?? -1;
      if (p < 0) return false;
      const pi = Array.from(layout.node).indexOf(p);
      return (
        (layout.x[i] ?? 0) < (layout.x[pi] ?? 0) - 1e-9 ||
        (layout.x[i] ?? 0) + (layout.w[i] ?? 0) > (layout.x[pi] ?? 0) + (layout.w[pi] ?? 0) + 1e-9
      );
    });
    expect(bad).toEqual([]);
  });

  it('puts the heaviest stack leftmost by default', () => {
    const top = Array.from({ length: layout.length }, (_, i) => i).filter(
      (i) => layout.depth[i] === 1,
    );
    const leftmost = top.reduce((a, b) => ((layout.x[b] ?? 0) < (layout.x[a] ?? 0) ? b : a));
    const widest = top.reduce((a, b) => ((layout.w[b] ?? 0) > (layout.w[a] ?? 0) ? b : a));
    expect(leftmost).toBe(widest);
    expect(nameAt(widest)).toBe('getOrders');
  });

  it('sorts alphabetically for stable comparison', () => {
    const alpha = flameLayout(m, view, { sort: 'alphabetical' });
    const names = Array.from({ length: alpha.length }, (_, i) => i)
      .filter((i) => alpha.depth[i] === 1)
      .map((i) => describeFunction(m, alpha.fn[i] ?? 0, view.syntheticPackages).name);
    expect(names).toEqual([...names].sort());
  });

  it('flips rows for classic flames', () => {
    const classic = flameLayout(m, view, { orientation: 'classic' });
    expect(classic.row[0]).toBe(classic.maxDepth);
    expect(layout.row[0]).toBe(0);
  });

  it('zooms into a node so its width becomes 1 and reports the path', () => {
    const node =
      layout.node[
        Array.from({ length: layout.length }, (_, i) => i).find(
          (i) => nameAt(i) === 'renderInvoice',
        ) ?? 0
      ] ?? 0;
    const zoom = flameLayout(m, view, { zoomNode: node });
    expect(zoom.w[0]).toBe(1);
    expect(zoom.node[0]).toBe(node);
    expect(zoom.depth[0]).toBe(0);
    expect(zoom.zoomPath[0]).toBe(0);
    expect(zoom.zoomPath[zoom.zoomPath.length - 1]).toBe(node);
  });

  it('colors by self time with the hottest rect at 1', () => {
    const self = flameLayout(m, view, { colorBy: 'self' });
    expect(Math.max(...self.intensity)).toBe(1);
    const hot = self.intensity.indexOf(1);
    expect(describeFunction(m, self.fn[hot] ?? 0).name).toBe('lineTotal');
  });

  it('omits rects narrower than minWidth', () => {
    const slim = flameLayout(m, view, { minWidth: 0.05 });
    expect(slim.length).toBeLessThan(layout.length);
    expect(Math.min(...slim.w.slice(1))).toBeGreaterThanOrEqual(0.05);
  });

  it('is deterministic and keeps parents before children', () => {
    const again = flameLayout(m, view);
    expect(Array.from(again.node)).toEqual(Array.from(layout.node));
    for (let i = 1; i < layout.length; i++) {
      expect(layout.node[i] ?? 0).toBeGreaterThan(layout.node[0] ?? 0);
    }
  });

  it('requires a diff for differential coloring', () => {
    expect(() => flameLayout(m, view, { colorBy: 'diff' })).toThrow(/diffModels/);
  });
});

describe('flame graph differential coloring', () => {
  it('maps head function changes onto rects', () => {
    const m = analyze(synthCapture([{ stack: ['a', 'b'], samples: 4 }]));
    const view = applyTransforms(m, 0, []);
    const b =
      Array.from({ length: m.functions.length }, (_, f) => f).find(
        (f) => m.strings[m.functions.name[f] ?? 0] === 'b',
      ) ?? 0;
    const delta = new Float64Array(m.functions.length);
    const change = new Int8Array(m.functions.length);
    delta[b] = 0.3;
    change[b] = 1;
    const diff: ModelDiff = {
      functions: [],
      headSelfShareDelta: delta,
      headChange: change,
      baseBusyUs: 1,
      headBusyUs: 1,
    };
    const layout = flameLayout(m, view, { colorBy: 'diff', diff });
    const i = Array.from(layout.fn).indexOf(b);
    expect(layout.change[i]).toBe(1);
    expect(layout.intensity[i]).toBe(1);
    expect(layout.change[0]).toBe(0);
  });
});
