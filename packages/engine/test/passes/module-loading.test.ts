import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { ORIGIN_NAMES } from '../../src/model.js';
import { applyTransforms } from '../../src/query/view.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';

const model = loadModel('eslint-cli');
const nameOf = (fn: number) => model.strings[model.functions.name[fn] ?? 0] ?? '';
const fileOf = (fn: number) => model.strings[model.functions.file[fn] ?? 0] ?? '';

function fnsNamed(prefix: string): number[] {
  const out: number[] = [];
  for (let fn = 0; fn < model.functions.length; fn++)
    if (nameOf(fn).startsWith(prefix)) out.push(fn);
  return out;
}

describe('module loading fold', () => {
  it('marks CommonJS and ESM loader frames as plumbing', () => {
    const loaders: number[] = [];
    for (let fn = 0; fn < model.functions.length; fn++) {
      if (fileOf(fn).startsWith('node:internal/modules/')) loaders.push(fn);
    }
    expect(loaders.length).toBeGreaterThan(10);
    expect(loaders.every((fn) => model.functions.plumbing[fn] === 1)).toBe(true);
    expect(loaders.every((fn) => model.functions.loader[fn] === 1)).toBe(true);
  });

  it('names a loaded file top-level function after the file, by package path', () => {
    const linter = fnsNamed('require ▸ eslint/lib/linter/linter.js');
    expect(linter).toHaveLength(1);
    const fn = linter[0] ?? 0;
    expect(ORIGIN_NAMES[model.functions.origin[fn] ?? 0]).toBe('user');
    expect(model.functions.plumbing[fn]).toBe(0);
    expect(model.functions.loader[fn]).toBe(1);
  });

  it('names dependency files by their package path too', () => {
    expect(fnsNamed('require ▸ typescript-eslint/dist/index.js')).toHaveLength(1);
  });

  it('names the entry module', () => {
    expect(fnsNamed('require ▸ eslint/bin/eslint.js')).toHaveLength(1);
  });

  it('uses the project-relative path for project files and import for ESM', () => {
    const steps = [
      { stack: [{ name: '', url: 'file:///project/src/a.js', line: 0, col: 0 }], samples: 3 },
      { stack: [{ name: '', url: 'file:///project/src/b.mjs', line: 0, col: 0 }], samples: 3 },
    ];
    const m = analyze(synthCapture(steps));
    const names = Array.from(
      { length: m.functions.length },
      (_, fn) => m.strings[m.functions.name[fn] ?? 0],
    );
    expect(names).toContain('require ▸ src/a.js');
    expect(names).toContain('import ▸ src/b.mjs');
  });

  it('leaves named functions and non-top-level anonymous functions alone', () => {
    const steps = [
      { stack: [{ name: '', url: 'file:///project/src/a.js', line: 10, col: 4 }], samples: 3 },
      { stack: [{ name: 'run', url: 'file:///project/src/a.js', line: 0, col: 0 }], samples: 3 },
    ];
    const m = analyze(synthCapture(steps));
    const names = Array.from(
      { length: m.functions.length },
      (_, fn) => m.strings[m.functions.name[fn] ?? 0],
    );
    expect(names.some((n) => n?.startsWith('require ▸'))).toBe(false);
  });

  describe('in a view with plumbing merged', () => {
    const view = applyTransforms(model, model.primaryTrack, [
      { kind: 'merge-plumbing' },
      { kind: 'drop-idle' },
    ]);
    const fnOfNode = (n: number) => view.tree.fn[n] ?? 0;

    it('shows no loader frames between nested requires', () => {
      let loaderNodes = 0;
      for (let n = 1; n < view.tree.length; n++) {
        if (fileOf(fnOfNode(n)).startsWith('node:internal/modules/')) loaderNodes++;
      }
      expect(loaderNodes).toBe(0);
    });

    it('reads a require chain as one row per module with the nested requires as children', () => {
      let nested = 0;
      for (let n = 1; n < view.tree.length; n++) {
        const parent = view.tree.parent[n] ?? 0;
        if (
          nameOf(fnOfNode(n)).startsWith('require ▸') &&
          nameOf(fnOfNode(parent)).startsWith('require ▸')
        )
          nested++;
      }
      expect(nested).toBeGreaterThan(30);
    });

    it('gives a module its load time including the modules it requires', () => {
      const entry = fnsNamed('require ▸ eslint/lib/cli.js')[0] ?? 0;
      let node = -1;
      for (let n = 1; n < view.tree.length; n++) if (fnOfNode(n) === entry) node = n;
      expect(node).toBeGreaterThan(0);
      const childTotal = (() => {
        let sum = 0;
        const end = view.tree.subtreeEnd[node] ?? 0;
        for (let c = node + 1; c < end; c = view.tree.subtreeEnd[c] ?? c + 1)
          sum += view.tree.total[c] ?? 0;
        return sum;
      })();
      expect(view.tree.total[node]).toBeGreaterThanOrEqual(childTotal);
      expect(view.tree.total[node]).toBeGreaterThan(0);
    });
  });
});
