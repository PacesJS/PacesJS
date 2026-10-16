import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import type { ExecutionModel } from '../../src/model.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';

function find(m: ExecutionModel, name: string, fileEndsWith: string): number {
  for (let fn = 0; fn < m.functions.length; fn++) {
    if (m.strings[m.functions.name[fn] ?? 0] !== name) continue;
    if ((m.strings[m.functions.file[fn] ?? 0] ?? '').endsWith(fileEndsWith)) return fn;
  }
  return -1;
}

const tickLines = (m: ExecutionModel, track: number, fn: number): number[] => {
  const lines = m.tracks[track]?.lines;
  return Array.from(lines?.line.subarray(lines.offset[fn], lines.offset[fn + 1]) ?? []);
};

describe('function lines are the definition line (1-based) in source-mapped TypeScript', () => {
  const m = loadModel('orders-server');

  it.each([
    ['lineTotal', 'src/util/money.ts', 6],
    ['getOrders', 'src/routes/orders.ts', 4],
    ['buildInvoiceRows', 'src/render/invoice.ts', 13],
    ['renderInvoice', 'src/render/invoice.ts', 24],
    ['loadTemplate', 'src/render/template.ts', 14],
    ['flushMetrics', 'src/util/metrics.ts', 3],
    ['authenticate', 'src/middleware/auth.ts', 3],
  ])('%s in %s', (name, file, line) => {
    const fn = find(m, name, file);
    expect(fn).toBeGreaterThanOrEqual(0);
    expect(m.functions.line[fn]).toBe(line);
    expect(m.functions.mapped[fn]).toBe(1);
  });

  it('maps line ticks to original lines inside the function', () => {
    const fn = find(m, 'lineTotal', 'src/util/money.ts');
    const lines = tickLines(m, 0, fn);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l >= 7 && l <= 14)).toBe(true);
    expect(lines).toContain(9);
  });
});

describe('function lines are the definition line (1-based) in plain JavaScript', () => {
  const m = loadModel('eslint-cli');

  it.each([
    ['verify', 'lib/linter/linter.js', 1644],
    ['runRules', 'lib/linter/linter.js', 1046],
    ['verifyAndFix', 'lib/linter/linter.js', 2529],
    ['verifyText', 'lib/eslint/eslint-helpers.js', 1158],
    ['readAndVerifyFile', 'lib/eslint/eslint-helpers.js', 1304],
    ['lintFiles', 'lib/eslint/eslint.js', 949],
    ['parse', 'lib/languages/js/index.js', 237],
    ['execute', 'lib/cli.js', 205],
    ['traverseSync', 'lib/linter/source-code-traverser.js', 269],
    ['main', 'bin/eslint.js', 138],
  ])('%s in %s', (name, file, line) => {
    const fn = find(m, name, file);
    expect(fn).toBeGreaterThanOrEqual(0);
    expect(m.functions.line[fn]).toBe(line);
    expect(m.functions.mapped[fn]).toBe(0);
  });

  it.each([
    ['traverseSync', 'lib/linter/source-code-traverser.js', [279]],
    ['execute', 'lib/cli.js', [233]],
    ['runRules', 'lib/linter/linter.js', [1085, 1214]],
  ])('keeps V8 line ticks as the 1-based lines they are: %s', (name, file, expected) => {
    expect(tickLines(m, m.primaryTrack, find(m, name, file))).toEqual(expected);
  });
});

describe('line bases', () => {
  const url = 'file:///project/src/app.js';

  it('turns V8 0-based function lines into 1-based and keeps 1-based tick lines', () => {
    const model = analyze(
      synthCapture(
        [
          {
            stack: [{ name: 'f', url, line: 41, col: 2 }],
            samples: 5,
            ticks: [{ line: 45, ticks: 5 }],
          },
        ],
        { argv: ['node', '/project/src/app.js'] },
      ),
    );
    const fn = find(model, 'f', 'src/app.js');
    expect(model.functions.line[fn]).toBe(42);
    expect(tickLines(model, 0, fn)).toEqual([45]);
  });
});

describe('Windows paths', () => {
  const win = 'C:\\Users\\me\\proj';
  const entry = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\eslint\\bin\\eslint.js';

  it('keeps the drive letter outside the project root', () => {
    const model = analyze(
      synthCapture(
        [
          {
            stack: [
              {
                name: 'run',
                url: 'file:///C:/Users/me/AppData/Roaming/npm/node_modules/eslint/lib/a.js',
              },
            ],
            samples: 3,
          },
        ],
        { projectRoot: win, argv: ['node', entry] },
      ),
    );
    expect(model.strings).toContain('C:/Users/me/AppData/Roaming/npm/node_modules/eslint/lib/a.js');
    expect(model.strings.some((s) => s.startsWith('/Users/'))).toBe(false);
    expect(model.target.entry).toBe(
      'C:/Users/me/AppData/Roaming/npm/node_modules/eslint/bin/eslint.js',
    );
    expect(model.target.packages).toEqual(['eslint']);
  });

  it('is project-relative inside the root, whatever the case of the drive letter', () => {
    const model = analyze(
      synthCapture(
        [{ stack: [{ name: 'run', url: 'file:///c:/Users/me/proj/src/a.js' }], samples: 3 }],
        {
          projectRoot: win,
        },
      ),
    );
    expect(model.strings).toContain('src/a.js');
  });

  it('resolves source map sources against a drive-letter script URL', () => {
    const url = 'file:///C:/Users/me/proj/dist/a.js';
    const map = JSON.stringify({
      version: 3,
      file: 'a.js',
      sources: ['../src/a.ts', '../../other/b.ts'],
      names: [],
      mappings: 'AAAA;AACA',
    });
    const model = analyze(
      synthCapture(
        [
          { stack: [{ name: 'a', url, line: 0, col: 0 }], samples: 3 },
          { stack: [{ name: 'b', url, line: 1, col: 0 }], samples: 3 },
        ],
        { projectRoot: win, sourceMaps: { [url]: map } },
      ),
    );
    expect(model.strings).toContain('src/a.ts');
    expect(model.strings.some((s) => s.startsWith('/Users/'))).toBe(false);
  });
});
