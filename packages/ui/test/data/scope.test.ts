import { DEFAULT_TRANSFORMS as ENGINE_DEFAULTS } from '@pacesjs/engine';
import { describe, expect, it } from 'vitest';
import { locationOf, modelCtx, scopeView, toEngineStack, trackIndexOf } from '../../src/data/scope';
import { DEFAULT_TRANSFORMS } from '../../src/state/types';
import { ordersModel } from '../helpers/real-model';

const model = ordersModel();
const ctx = modelCtx(model);
const F = model.functions.length;

describe('UI transform stack to engine stack', () => {
  it('maps the default stack onto the engine defaults', () => {
    expect(toEngineStack(ctx, DEFAULT_TRANSFORMS, [], null)).toEqual([...ENGINE_DEFAULTS]);
  });

  it('puts the time range first so later transforms see only that window', () => {
    const stack = toEngineStack(ctx, [{ k: 'invert' }], [], [100, 200]);
    expect(stack).toEqual([{ kind: 'time-range', start: 100, end: 200 }, { kind: 'invert' }]);
  });

  it('keeps an expanded package open by collapsing only the other dependency packages', () => {
    const stack = toEngineStack(ctx, [{ k: 'collapse-deps' }], ['ajv'], null);
    expect(stack).toContainEqual({ kind: 'collapse-package', pkg: 'fast-uri' });
    expect(stack).not.toContainEqual({ kind: 'collapse-package', pkg: 'ajv' });
    expect(stack.some((t) => t.kind === 'collapse-dependencies')).toBe(false);
  });

  it('drops transforms aimed at a collapsed-package id, which only exists inside one view', () => {
    expect(toEngineStack(ctx, [{ k: 'merge-fn', fn: F + 1 }], [], null)).toEqual([]);
  });

  it('translates function and path transforms one to one', () => {
    expect(
      toEngineStack(
        ctx,
        [
          { k: 'focus-fn', fn: 3 },
          { k: 'focus-self', fn: 4 },
          { k: 'collapse-rec', fn: 5 },
          { k: 'drop-fn', fn: 6 },
          { k: 'focus-node', path: [1, 2] },
          { k: 'merge-node', path: [1] },
        ],
        [],
        null,
      ),
    ).toEqual([
      { kind: 'focus-function', fn: 3 },
      { kind: 'focus-function-self', fn: 4 },
      { kind: 'collapse-recursion', fn: 5 },
      { kind: 'drop-samples', fn: 6 },
      { kind: 'focus-subtree', path: [1, 2] },
      { kind: 'merge-node', path: [1] },
    ]);
  });
});

describe('tracks', () => {
  it('resolves "all" and unknown tracks to the first track', () => {
    expect(trackIndexOf(model, 'all')).toBe(0);
    expect(trackIndexOf(model, 'nope')).toBe(0);
  });

  it('finds a worker track by id', () => {
    expect(trackIndexOf(model, model.tracks[1]?.id ?? '')).toBe(1);
  });
});

describe('collapsed-package ids', () => {
  const pkgId = (pkg: string): number => F + ctx.pkgs.indexOf(pkg);
  const ajvIn = (stack: ReturnType<typeof toEngineStack>): number | undefined => {
    const s = scopeView(ctx, 0, stack);
    const node = Array.from(s.view.tree.fn).find((f) => f >= F && s.info(s.out(f)).pkg === 'ajv');
    return node === undefined ? undefined : s.out(node);
  };

  it('are stable across different transform stacks', () => {
    const a = ajvIn(toEngineStack(ctx, DEFAULT_TRANSFORMS, [], null));
    const b = ajvIn(
      toEngineStack(
        ctx,
        [
          { k: 'collapse-pkg', pkg: 'json-schema-traverse' },
          { k: 'collapse-pkg', pkg: 'ajv' },
        ],
        [],
        null,
      ),
    );
    expect(a).toBe(pkgId('ajv'));
    expect(b).toBe(pkgId('ajv'));
  });

  it('describe as a dependency package with a node_modules location', () => {
    const s = scopeView(ctx, 0, toEngineStack(ctx, DEFAULT_TRANSFORMS, [], null));
    const info = s.info(pkgId('ajv'));
    expect(info).toMatchObject({ name: 'ajv', synthetic: true, origin: 1 });
  });
});

describe('classification by the engine', () => {
  it('reports no function from node_modules as your code', () => {
    const f = model.functions;
    const userInDeps = Array.from({ length: f.length }, (_, i) => i).filter(
      (i) => (model.strings[f.file[i] ?? 0] ?? '').includes('node_modules') && f.origin[i] === 0,
    );
    expect(userInDeps).toEqual([]);
  });

  it('finds ajv, json-schema-traverse and fast-uri as dependencies', () => {
    expect(ctx.depPkgs).toEqual(['ajv', 'fast-uri', 'json-schema-traverse']);
  });
});

describe('where a collapsed package says it is', () => {
  const pkg = (name: string) =>
    ({ synthetic: true, pkg: name, file: '', line: 0 }) as Parameters<typeof locationOf>[0];

  it('names an npm package under node_modules', () => {
    expect(locationOf(pkg('fast-levenshtein'))).toBe('node_modules/fast-levenshtein');
  });

  it('names a page third party by its host alone', () => {
    expect(locationOf(pkg('static.licdn.com'))).toBe('static.licdn.com');
  });
});
