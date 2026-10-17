import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';
import type { Step } from '../helpers/synth.js';

const declared = (url: string) => ({
  scriptId: '1',
  url,
  sourceMapURL: 'missing.js.map',
  hash: '',
});

describe('warnings are aggregated per kind', () => {
  it('reports hundreds of dependency files without a source map as one info entry', () => {
    const warnings = loadModel('eslint-cli').meta.warnings;
    const missing = warnings.filter((w) => w.kind === 'dependency-source-map-missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ severity: 'info' });
    expect(missing[0]?.count).toBeGreaterThan(100);
    expect(missing[0]?.summary).toMatch(/dependency files have no source map.*expected/);
  });

  it('keeps at most 20 sample paths and shows packages, not machine paths', () => {
    const details =
      loadModel('eslint-cli').meta.warnings.find((w) => w.kind === 'dependency-source-map-missing')
        ?.details ?? [];
    expect(details).toHaveLength(20);
    expect(details.every((d) => !d.includes('node_modules/'))).toBe(true);
  });

  it('never has two entries of one kind', () => {
    const kinds = loadModel('eslint-cli-wrapped').meta.warnings.map((w) => w.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('does not warn about the target eslint package for its dependencies', () => {
    const warnings = loadModel('eslint-cli').meta.warnings;
    expect(warnings.some((w) => w.severity === 'warn')).toBe(false);
  });

  it('warns when a map is missing for the target code', () => {
    const steps: Step[] = [
      { stack: [{ name: 'a', url: 'file:///project/src/app.js' }], samples: 5 },
    ];
    const model = analyze(
      synthCapture(steps, { scripts: [declared('file:///project/src/app.js')] }),
    );
    expect(model.meta.warnings).toEqual([
      {
        kind: 'source-map-missing',
        severity: 'warn',
        summary: '1 file of the target has no source map; showing generated names and lines.',
        count: 1,
        details: ['src/app.js'],
      },
    ]);
  });

  it('folds many dependency files into one info entry with at most 20 samples', () => {
    const urls = Array.from(
      { length: 30 },
      (_, i) => `file:///project/node_modules/p${i}/index.js`,
    );
    const steps: Step[] = urls.map((url) => ({ stack: [{ name: 'dep', url }], samples: 2 }));
    const model = analyze(
      synthCapture(steps, { scripts: urls.map(declared), argv: ['node', '/project/src/app.js'] }),
    );
    expect(model.meta.warnings).toHaveLength(1);
    expect(model.meta.warnings[0]).toMatchObject({
      kind: 'dependency-source-map-missing',
      severity: 'info',
      count: 30,
    });
    expect(model.meta.warnings[0]?.details).toHaveLength(20);
  });

  it('reports a map that is not JSON as one warning', () => {
    const url = 'file:///project/src/app.js';
    const steps: Step[] = [{ stack: [{ name: 'a', url }], samples: 5 }];
    const model = analyze(
      synthCapture(steps, { scripts: [declared(url)], sourceMaps: { [url]: 'not json' } }),
    );
    expect(model.meta.warnings.map((w) => [w.kind, w.severity, w.count])).toEqual([
      ['source-map-invalid', 'warn', 1],
    ]);
  });
});

describe('missing source maps of a target that is a published package', () => {
  const url = 'file:///project/node_modules/tool/lib/main.js';
  const steps: Step[] = [{ stack: [{ name: 'run', url }], samples: 5 }];

  it('is info, not warn: the user cannot add a map to a published package', () => {
    const model = analyze(
      synthCapture(steps, {
        argv: ['node', '/project/node_modules/tool/bin/tool.js'],
        scripts: [declared(url)],
      }),
    );
    expect(model.meta.warnings).toEqual([
      {
        kind: 'target-package-source-map-missing',
        severity: 'info',
        summary:
          '1 file of the target package has no source map; names are generated names, which is expected for published packages.',
        count: 1,
        details: ['tool/lib/main.js'],
      },
    ]);
  });

  it('stays a warning for the code of the user project', () => {
    const own = 'file:///project/src/app.js';
    const model = analyze(
      synthCapture([{ stack: [{ name: 'a', url: own }], samples: 5 }], {
        argv: ['node', '/project/src/app.js'],
        scripts: [declared(own)],
      }),
    );
    expect(model.meta.warnings.map((w) => [w.kind, w.severity])).toEqual([
      ['source-map-missing', 'warn'],
    ]);
  });

  it('keeps both notes when a package target and project code both lack maps', () => {
    const own = 'file:///project/src/glue.js';
    const model = analyze(
      synthCapture(
        [
          { stack: [{ name: 'run', url }], samples: 3 },
          { stack: [{ name: 'glue', url: own }], samples: 3 },
        ],
        {
          argv: ['node', '/project/node_modules/tool/bin/tool.js'],
          scripts: [declared(url), declared(own)],
        },
      ),
    );
    expect(model.meta.warnings.map((w) => [w.kind, w.severity])).toEqual([
      ['source-map-missing', 'warn'],
      ['target-package-source-map-missing', 'info'],
    ]);
  });

  it('is only an info note for the real tsc-like case: a package entry, no warn anywhere', () => {
    const model = analyze(
      synthCapture(steps, {
        argv: ['node', '/project/node_modules/tool/bin/tool.js'],
        scripts: [declared(url)],
      }),
    );
    expect(model.meta.warnings.some((w) => w.severity === 'warn')).toBe(false);
  });
});
