import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import type { ExecutionModel } from '../../src/model.js';
import { functionSource } from '../../src/query/source.js';
import { applyTransforms } from '../../src/query/view.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';

const fnId = (m: ExecutionModel, name: string): number =>
  Array.from({ length: m.functions.length }, (_, f) => f).find(
    (f) => m.strings[m.functions.name[f] ?? 0] === name,
  ) ?? -1;

describe('function source info on the orders server', () => {
  const m = loadModel('orders-server');
  const view = applyTransforms(m, 0, []);
  const info = functionSource(m, view, fnId(m, 'lineTotal'));

  it('puts the hot line of lineTotal at original line 9', () => {
    expect(info.file).toBe('zoo/orders-server/src/util/money.ts');
    expect(info.hottestLine).toBe(9);
    const hot = info.lines.find((l) => l.line === 9);
    expect(hot?.share).toBeGreaterThan(0.7);
    expect(info.lines.map((l) => l.line)).toEqual(
      [...info.lines.map((l) => l.line)].sort((a, b) => a - b),
    );
  });

  it('reports self and total time from the view', () => {
    expect(info.selfUs / 1000).toBeGreaterThan(1800);
    expect(info.totalUs).toBeGreaterThanOrEqual(info.selfUs);
    expect(info.totalUs - info.selfUs).toBeLessThan(10_000);
  });

  it('lists callees with time, largest first, without a call-site line', () => {
    const caller = functionSource(m, view, fnId(m, 'buildInvoiceRows'));
    expect(caller.callSites[0]?.callee).toBe(fnId(m, 'lineTotal'));
    expect(caller.callSites[0]?.line).toBe(0);
    expect(caller.callSites[0]?.calleeUs).toBeGreaterThan(1_800_000);
    expect(caller.callSites[1]?.callee).toBe(fnId(m, 'formatCurrency'));
  });

  it('gives a sparkline of when the function ran', () => {
    expect(info.sparkline.length).toBe(60);
    expect(Math.max(...info.sparkline)).toBeGreaterThan(0.5);
    expect(info.sparkline[0]).toBe(0);
  });

  it('returns empty lines for a collapsed package node', () => {
    const v = applyTransforms(m, 0, [{ kind: 'collapse-package', pkg: 'ajv' }]);
    const synth = functionSource(m, v, m.functions.length);
    expect(synth.name).toBe('ajv');
    expect(synth.lines).toEqual([]);
    expect(synth.totalUs).toBeGreaterThan(0);
  });
});

describe('function source edge cases', () => {
  it('counts recursive total once and flags nothing for plain files', () => {
    const m = analyze(synthCapture([{ stack: ['f', 'f', 'g'], samples: 4 }]));
    const info = functionSource(m, applyTransforms(m, 0, []), fnId(m, 'f'));
    expect(info.totalUs).toBe(4000);
    expect(info.selfUs).toBe(0);
    expect(info.mapMissing).toBe(false);
    expect(info.callSites.map((c) => c.callee)).toEqual([fnId(m, 'g')]);
  });
});

describe('definition lines', () => {
  const find = (m: ExecutionModel, name: string, fileEndsWith: string, line: number): number => {
    for (let fn = 0; fn < m.functions.length; fn++) {
      if (m.strings[m.functions.name[fn] ?? 0] !== name) continue;
      if (!(m.strings[m.functions.file[fn] ?? 0] ?? '').endsWith(fileEndsWith)) continue;
      if (m.functions.line[fn] === line) return fn;
    }
    return -1;
  };
  const orders = loadModel('orders-server');
  const eslint = loadModel('eslint-cli');

  it.each([
    ['function declaration', 'lineTotal', 'src/util/money.ts', 6],
    ['async function declaration', 'getOrders', 'src/routes/orders.ts', 4],
    ['nested function declaration', 'request', 'src/server.ts', 29],
    ['function in another file', 'crunch', 'src/worker.ts', 3],
    ['anonymous async arrow passed to createServer', '', 'src/server.ts', 12],
    ['anonymous async arrow passed to listen', '', 'src/server.ts', 38],
    ['anonymous arrow in a promise executor', '', 'src/db/orders.ts', 9],
  ])('source-mapped TypeScript: %s', (_what, name, file, line) => {
    const fn = find(orders, name, file, line);
    expect(fn).toBeGreaterThanOrEqual(0);
    const info = functionSource(orders, applyTransforms(orders, 0, []), fn);
    expect(info.definitionLine).toBe(line);
    expect(info.definitionLine).toBe(info.line);
  });

  it.each([
    ['class method', 'verify', 'lib/linter/linter.js', 1644],
    ['private method', '#flatVerifyWithoutProcessors', 'lib/linter/linter.js', 1832],
    ['class constructor', 'ESLint', 'lib/eslint/eslint.js', 719],
    ['constructor with a class name', 'Config', 'lib/config/config.js', 380],
    [
      'constructor of another class',
      'SourceCode',
      'lib/languages/js/source-code/source-code.js',
      414,
    ],
    ['arrow assigned to module.exports', 'module.exports', 'lib/shared/ajv.js', 18],
    ['arrow as an object property', 'consistent-return', 'lib/rules/index.js', 37],
    ['anonymous async arrow in a call', '', 'lib/eslint/eslint.js', 628],
    ['function declaration', 'runRules', 'lib/linter/linter.js', 1046],
  ])('plain JavaScript: %s', (_what, name, file, line) => {
    const fn = find(eslint, name, file, line);
    expect(fn).toBeGreaterThanOrEqual(0);
    const info = functionSource(eslint, applyTransforms(eslint, eslint.primaryTrack, []), fn);
    expect(info.definitionLine).toBe(line);
  });

  it('maps an export default function to the line of the export in the original file', () => {
    const url = 'file:///project/dist/a.js';
    const map = JSON.stringify({
      version: 3,
      file: 'a.js',
      sources: ['../src/a.ts'],
      names: [],
      mappings: 'AAAA;AACA;AACA;AACA;AACA;AACA,eAAe',
    });
    const m = analyze(
      synthCapture([{ stack: [{ name: 'handler', url, line: 5, col: 0 }], samples: 3 }], {
        sourceMaps: { [url]: map },
      }),
    );
    const info = functionSource(m, applyTransforms(m, 0, []), fnId(m, 'handler'));
    expect(info.definitionLine).toBe(6);
    expect(info.file).toBe('src/a.ts');
  });
});

describe('what the function itself did', () => {
  const m = loadModel('orders-server');
  const view = applyTransforms(m, 0, []);

  it('lists the lines that have self time, hottest first', () => {
    const info = functionSource(m, view, fnId(m, 'lineTotal'));
    expect(info.hotLines[0]).toMatchObject({ line: 9 });
    const selfs = info.hotLines.map((l) => l.selfUs);
    expect(selfs).toEqual([...selfs].sort((a, b) => b - a));
    expect(info.hotLines.every((l) => l.selfUs > 0)).toBe(true);
  });

  it('says there are self lines when there are', () => {
    const info = functionSource(m, view, fnId(m, 'lineTotal'));
    expect(info.lineInfo.status).toBe('self-lines');
    expect(info.lineInfo.reason).toMatch(/line/);
  });

  it('lists callees with the time under the function, largest first', () => {
    const info = functionSource(m, view, fnId(m, 'buildInvoiceRows'));
    expect(info.calleeTime.map((c) => c.name).slice(0, 2)).toEqual(['lineTotal', 'formatCurrency']);
    expect(info.calleeTime[0]?.totalUs).toBeGreaterThan(1_800_000);
    expect(info.calleeTime[0]?.selfUs).toBeGreaterThan(1_800_000);
    expect(info.calleeTime[0]).toMatchObject({ fn: fnId(m, 'lineTotal'), pkg: '' });
    const totals = info.calleeTime.map((c) => c.totalUs);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
  });

  it('does not invent call-site lines', () => {
    const info = functionSource(m, view, fnId(m, 'buildInvoiceRows'));
    expect(info.calleeTime.every((c) => c.line === undefined)).toBe(true);
  });

  it('explains a function whose own time is small: the time is in its callees', () => {
    const info = functionSource(m, view, fnId(m, 'loadTemplate'));
    expect(info.lines).toEqual([]);
    expect(info.lineInfo.status).toBe('no-self-time');
    expect(info.lineInfo.reason).toMatch(/callee/i);
    expect(info.lineInfo.reason).toMatch(/ms/);
    expect(info.calleeTime.length).toBeGreaterThan(0);
  });

  it('says honestly when V8 gave no line data for a function that did run', () => {
    const steps = [{ stack: ['work'], samples: 20 }];
    const synth = analyze(synthCapture(steps));
    const info = functionSource(synth, applyTransforms(synth, 0, []), fnId(synth, 'work'));
    expect(info.lines).toEqual([]);
    expect(info.lineInfo.status).toBe('no-line-data');
    expect(info.lineInfo.reason).toMatch(/V8/);
  });

  it('explains collapsed packages and native frames', () => {
    const pkg = functionSource(
      m,
      applyTransforms(m, 0, [{ kind: 'collapse-package', pkg: 'ajv' }]),
      m.functions.length,
    );
    expect(pkg.lineInfo.status).toBe('no-line-data');
    expect(pkg.lineInfo.reason).toMatch(/package/);
    expect(pkg.definitionLine).toBe(0);
  });
});

describe('deopt marks in function source info', () => {
  const m = loadModel('deopt-loop');
  const view = applyTransforms(m, 0, []);

  it('lists where V8 threw away optimized code, with the original line', () => {
    const info = functionSource(m, view, fnId(m, 'price'));
    expect(info.deopts).toEqual([{ reason: 'wrong map', kind: 'eager', line: 6, count: 10 }]);
  });

  it('is empty for a function V8 never deoptimized', () => {
    const orders = loadModel('orders-server');
    const v = applyTransforms(orders, 0, []);
    expect(functionSource(orders, v, fnId(orders, 'lineTotal')).deopts).toEqual([]);
  });
});
