import { describe, expect, it } from 'vitest';
import { Origin } from '../../src/model.js';
import type { ExecutionModel } from '../../src/model.js';
import { DEFAULT_TRANSFORMS } from '../../src/query/types.js';
import type { TransformedView } from '../../src/query/types.js';
import { applyTransforms, describeFunction } from '../../src/query/view.js';
import { waterfallForRun } from '../../src/query/waterfall.js';
import { FIXTURES, loadModel } from '../helpers/fixtures.js';
import type { FixtureName } from '../helpers/fixtures.js';

const ESLINT: FixtureName[] = ['eslint-cli', 'eslint-cli-wrapped'];
const nameAt = (m: ExecutionModel, v: TransformedView, n: number) =>
  describeFunction(m, v.tree.fn[n] ?? 0, v.syntheticPackages).name;
const viewOf = (m: ExecutionModel) => applyTransforms(m, m.primaryTrack, DEFAULT_TRANSFORMS);

/** Nodes named `name`, with how many of the same name sit above them. */
function nestedCopies(m: ExecutionModel, v: TransformedView, name: string): number {
  let nested = 0;
  for (let n = 1; n < v.tree.length; n++) {
    if (nameAt(m, v, n) !== name) continue;
    for (let a = v.tree.parent[n] ?? 0; a > 0; a = v.tree.parent[a] ?? 0) {
      if (nameAt(m, v, a) === name) {
        nested++;
        break;
      }
    }
  }
  return nested;
}

describe.each(ESLINT)('%s: continuations do not pile up in one chain', (name) => {
  const m = loadModel(name);
  const v = viewOf(m);

  it('has files linted side by side, not one inside the other', () => {
    expect(nestedCopies(m, v, 'readAndVerifyFile')).toBe(0);
    expect(nestedCopies(m, v, 'lintFile')).toBe(0);
  });

  it('never attaches a file-level continuation under a rule frame', () => {
    const t = m.tracks[m.primaryTrack];
    const c = t?.continuations;
    for (let r = 0; r < (c?.length ?? 0); r++) {
      const p = c?.parentSpan[r] ?? -1;
      if (p < 0) continue;
      const fn = t?.spans.fn[p] ?? 0;
      const file = m.strings[m.functions.file[fn] ?? 0] ?? '';
      const pname = m.strings[m.functions.name[fn] ?? 0] ?? '';
      expect(file.includes('/lib/rules/')).toBe(false);
      expect(['ruleErrorHandler', 'createRuleListeners']).not.toContain(pname);
    }
  });

  it('keeps the tree shallow: depth comes from real call stacks, not from hops between tasks', () => {
    expect(Math.max(...Array.from(v.tree.depth))).toBeLessThan(70);
  });

  it('attaches no continuation deeper than twelve frames', () => {
    const t = m.tracks[m.primaryTrack];
    const c = t?.continuations;
    let deep = 0;
    for (let r = 0; r < (c?.length ?? 0); r++) {
      const p = c?.parentSpan[r] ?? -1;
      if (p >= 0 && (t?.spans.depth[p] ?? 0) > 12) deep++;
    }
    expect(deep).toBeLessThanOrEqual(3);
  });
});

describe('sanity of totals', () => {
  it.each([...FIXTURES])('%s: no function claims more time than the run has', (name) => {
    const m = loadModel(name);
    const v = viewOf(m);
    let max = 0;
    for (let n = 2; n < v.tree.length; n++) {
      const f = describeFunction(m, v.tree.fn[n] ?? 0, v.syntheticPackages);
      if (f.origin === Origin.User) max = Math.max(max, v.tree.total[n] ?? 0);
    }
    expect(max).toBeLessThanOrEqual(v.totalUs + 1);
  });

  it.each(ESLINT)(
    '%s: the waterfall and the view hang user frames under the same parents',
    (name) => {
      const m = loadModel(name);
      const v = viewOf(m);
      const edge = (a: number, b: number) => `${a}>${b}`;
      const fromView = new Set<string>();
      for (let n = 2; n < v.tree.length; n++) {
        const f = v.tree.fn[n] ?? 0;
        const p = v.tree.fn[v.tree.parent[n] ?? 0] ?? 0;
        if (f < m.functions.length && m.functions.origin[f] === Origin.User)
          fromView.add(edge(p, f));
      }
      const w = waterfallForRun(m, m.primaryTrack);
      const missing: string[] = [];
      for (const r of w.rows) {
        if (r.kind !== 'call' || r.parent < 0 || r.fn >= m.functions.length) continue;
        if (m.functions.origin[r.fn] !== Origin.User) continue;
        const p = w.rows[r.parent];
        if (!p || p.kind !== 'call') continue;
        if (!fromView.has(edge(p.fn, r.fn))) missing.push(edge(p.fn, r.fn));
      }
      expect(missing).toEqual([]);
    },
  );
});
