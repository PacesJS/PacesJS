import { describe, expect, it } from 'vitest';
import { loadCapture } from '../helpers/capture.js';
import { runPasses } from '../helpers/run-passes.js';
import { synthCapture } from '../helpers/synth.js';

describe('classification on the orders server', () => {
  const { functions } = runPasses(loadCapture('orders-server'));
  const find = (name: string, file?: string) =>
    functions.find((f) => f.name === name && (file === undefined || f.file.includes(file)));

  it('tags project TypeScript, mapped through the bundle source map, as user code', () => {
    expect(find('lineTotal')).toMatchObject({ origin: 'user', pkg: '' });
    expect(find('getOrders')).toMatchObject({
      origin: 'user',
      file: 'zoo/orders-server/src/routes/orders.ts',
    });
  });

  it('tags ajv code inside the bundle as a dependency named ajv', () => {
    expect(find('validateFunctionCode')).toMatchObject({ origin: 'dependency', pkg: 'ajv' });
  });

  it('tags node: internals, native frames, idle and gc', () => {
    expect(find('readFileSync', 'node:fs')?.origin).toBe('node');
    expect(find('readFileUtf8')?.origin).toBe('native');
    expect(find('(idle)')?.origin).toBe('idle');
    expect(find('(garbage collector)')?.origin).toBe('gc');
  });

  it("treats paces' own wrapper as hidden node plumbing, never user code", () => {
    const wrapper = functions.find((f) => f.name === 'import_node_http.Server.emit');
    expect(wrapper).toMatchObject({ origin: 'node', plumbing: true });
  });
});

describe('classification on pnpm paths', () => {
  const { functions } = runPasses(loadCapture('rxjs-chain'));

  it('reads the package name out of a pnpm store path', () => {
    const rx = functions.filter((f) => f.file.includes('node_modules/.pnpm/rxjs@'));
    expect(rx.length).toBeGreaterThan(10);
    expect(rx.every((f) => f.origin === 'dependency' && f.pkg === 'rxjs')).toBe(true);
  });
});

describe('classification edge cases', () => {
  const at = (path: string) => ({ name: 'f', url: `file:///project/${path}` });

  it('names scoped packages with both segments', () => {
    const { functions } = runPasses(
      synthCapture([{ stack: [at('node_modules/@acme/widgets/dist/a.js')], samples: 2 }]),
    );
    expect(functions.find((f) => f.name === 'f')).toMatchObject({
      origin: 'dependency',
      pkg: '@acme/widgets',
    });
  });

  it('marks known frameworks as framework, not dependency', () => {
    const { functions } = runPasses(
      synthCapture([{ stack: [at('node_modules/express/lib/router.js')], samples: 2 }]),
    );
    expect(functions.find((f) => f.name === 'f')).toMatchObject({
      origin: 'framework',
      pkg: 'express',
    });
  });

  it('lets user override patterns beat the built-in rules', () => {
    const capture = synthCapture([
      { stack: [at('node_modules/acme/a.js')], samples: 1 },
      { stack: [{ name: 'g', url: 'file:///project/vendor/lib.js' }], samples: 1 },
    ]);
    const { functions, ctx } = runPasses(capture, {
      classification: { 'node_modules/acme/': 'user', 'vendor/': 'dependency', '(': 'user' },
    });
    expect(functions.find((f) => f.name === 'f')?.origin).toBe('user');
    expect(functions.find((f) => f.name === 'g')?.origin).toBe('dependency');
    expect(ctx.warnings).toEqual([{ kind: 'invalid-pattern', severity: 'warn', detail: '(' }]);
  });
});
