import { SourceMapGenerator } from 'source-map-js';
import { describe, expect, it } from 'vitest';
import { ingest } from '../../src/passes/ingest.js';
import { resolveSourceMaps } from '../../src/passes/source-maps.js';
import type { RawCapture } from '../../src/raw.js';
import { loadCapture, makeContext } from '../helpers/capture.js';
import { synthCapture } from '../helpers/synth.js';

function run(capture: RawCapture) {
  const ctx = makeContext();
  const ing = ingest(capture, ctx);
  const result = resolveSourceMaps({ capture, ingest: ing }, ctx);
  const describeFn = (name: string) => {
    const f = ing.frames.name.findIndex((n) => ctx.strings.strings[n] === name);
    const fn = result.frameToFn[f] ?? 0;
    return {
      name: ctx.strings.strings[result.functions.name[fn] ?? 0],
      file: ctx.strings.strings[result.functions.file[fn] ?? 0],
      line: result.functions.line[fn],
      mapped: result.functions.mapped[fn],
      mapMissing: result.functions.mapMissing[fn],
    };
  };
  return { ctx, ing, result, describeFn };
}

function mapFor(source: string, original: { line: number; column: number; name?: string }) {
  const gen = new SourceMapGenerator({ file: 'bundle.js' });
  gen.addMapping({
    generated: { line: 1, column: 9 },
    original: { line: original.line, column: original.column },
    source,
    ...(original.name ? { name: original.name } : {}),
  });
  return gen.toString();
}

describe('source maps on the orders server bundle', () => {
  const { ctx, ing, describeFn, result } = run(loadCapture('orders-server'));

  it('maps bundled TypeScript back to project-relative original files and lines', () => {
    const fn = describeFn('lineTotal');
    expect(fn.file).toBe('zoo/orders-server/src/util/money.ts');
    expect(fn.line).toBe(6);
    expect(fn.mapped).toBe(1);
  });

  it('maps dependencies bundled into the output to their node_modules paths', () => {
    const fn = describeFn('validateFunctionCode');
    expect(fn.file).toContain(
      'node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/lib/compile/validate/index.ts',
    );
  });

  it('maps line ticks of a hot function to original lines', () => {
    const track = ing.tracks[0];
    const lines = new Set<number>();
    for (let i = 0; i < (track?.ticks.line.length ?? 0); i++) {
      if ((track?.ticks.ticks[i] ?? 0) > 1000) lines.add(result.tickLines[0]?.[i] ?? 0);
    }
    expect([...lines]).toEqual([9]);
  });

  it('keeps native and node: frames unmapped and unflagged', () => {
    const native = describeFn('readFileUtf8');
    expect(native.mapped).toBe(0);
    expect(native.mapMissing).toBe(0);
    expect(ctx.warnings).toEqual([]);
    expect(result.functions.length).toBeGreaterThan(100);
  });
});

describe('source maps edge cases', () => {
  const url = 'file:///project/dist/bundle.js';

  it('decodes inline data: URI maps and recovers the original name', () => {
    const map = mapFor('../src/real.ts', { line: 12, column: 4, name: 'computeTotals' });
    const b64 = btoa(map);
    const capture = synthCapture([{ stack: [{ name: 'a', url, line: 0, col: 9 }], samples: 3 }], {
      scripts: [
        { scriptId: '1', url, sourceMapURL: `data:application/json;base64,${b64}`, hash: 'h' },
      ],
    });
    const { describeFn, ctx } = run(capture);
    expect(describeFn('a')).toMatchObject({
      name: 'computeTotals',
      file: 'src/real.ts',
      line: 12,
      mapped: 1,
      mapMissing: 0,
    });
    expect(ctx.warnings).toEqual([]);
  });

  it('resolves webpack:// sources inside node_modules', () => {
    const map = mapFor('webpack://app/./node_modules/lodash/map.js', { line: 3, column: 0 });
    const capture = synthCapture([{ stack: [{ name: 'map', url, line: 0, col: 9 }], samples: 2 }], {
      sourceMaps: { [url]: map },
    });
    expect(run(capture).describeFn('map').file).toBe('node_modules/lodash/map.js');
  });

  it('degrades to generated names and flags the function when the map is missing', () => {
    const capture = synthCapture([{ stack: [{ name: 'a', url, line: 4, col: 2 }], samples: 2 }], {
      scripts: [{ scriptId: '1', url, sourceMapURL: 'bundle.js.map', hash: 'h' }],
    });
    const { describeFn, ctx } = run(capture);
    expect(describeFn('a')).toMatchObject({
      name: 'a',
      file: 'dist/bundle.js',
      line: 5,
      mapMissing: 1,
      mapped: 0,
    });
    expect(ctx.warnings).toEqual([]);
  });

  it('warns instead of throwing on a map that is not JSON', () => {
    const capture = synthCapture([{ stack: [{ name: 'a', url }], samples: 1 }], {
      sourceMaps: { [url]: '{not json' },
    });
    const { describeFn, ctx } = run(capture);
    expect(describeFn('a').mapMissing).toBe(1);
    expect(ctx.warnings).toEqual([
      { kind: 'source-map-invalid', severity: 'warn', detail: 'dist/bundle.js' },
    ]);
  });
});
