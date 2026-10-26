import { SourceMapGenerator } from 'source-map-js';
import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { Origin } from '../../src/model.js';
import type { ExecutionModel } from '../../src/model.js';
import { parseDeoptTrace } from '../../src/passes/deopts.js';
import { loadCapture } from '../helpers/capture.js';
import { loadModel } from '../helpers/fixtures.js';

const trace = (): string => loadCapture('deopt-loop').tracks[0]?.deoptTrace ?? '';

/** Rows of the deopt table for the user function called `name`, with their strings resolved. */
function rowsOf(m: ExecutionModel, name: string) {
  const rows = [];
  for (let i = 0; i < m.deopts.length; i++) {
    const fn = m.deopts.fn[i] ?? 0;
    if (m.strings[m.functions.name[fn] ?? 0] !== name) continue;
    if (m.functions.origin[fn] !== Origin.User) continue;
    rows.push({
      reason: m.strings[m.deopts.reason[i] ?? 0],
      count: m.deopts.count[i],
      line: m.deopts.line[i],
      col: m.deopts.col[i],
    });
  }
  return rows;
}

describe('parseDeoptTrace on the deopt-loop capture', () => {
  const events = parseDeoptTrace(trace());

  it('reads every deoptimization V8 reported, each with a position', () => {
    expect(events).toHaveLength(50);
  });

  it('gives the function, tier, reason and the normalized position of the first one', () => {
    expect(events[0]).toEqual({
      kind: 'eager',
      reason: "exit from OSR'd inner loop",
      tier: 'MAGLEV',
      fn: 'total',
      path: '/project/zoo/apps/deopt-loop.cjs',
      line: 11,
      col: 41,
    });
  });

  it('keeps the whole reason when it contains parentheses', () => {
    expect(events.some((e) => e.reason === 'prepare for on stack replacement (OSR)')).toBe(true);
  });

  it('reports a deopt in inlined code at the inlined function and names the caller position', () => {
    const inlined = events.filter((e) => e.fn === 'total' && e.reason === 'wrong map');
    expect(inlined).toHaveLength(7);
    expect(inlined[0]).toMatchObject({ line: 6, col: 15, inlinedAt: { line: 12, col: 51 } });
  });

  it('returns nothing for an empty trace', () => {
    expect(parseDeoptTrace('')).toEqual([]);
  });
});

describe('the deopt table of an analyzed run', () => {
  const m = loadModel('deopt-loop');

  it('puts a deopt that happened in inlined code on the function whose code it is', () => {
    expect(rowsOf(m, 'price')).toEqual([{ reason: 'wrong map', count: 10, line: 6, col: 15 }]);
  });

  it('keeps the deopts of the function V8 deoptimized under its own name', () => {
    const total = rowsOf(m, 'total');
    expect(total.find((r) => r.reason === "exit from OSR'd inner loop")?.count).toBe(33);
    expect(total.find((r) => r.reason === 'overflow')?.count).toBe(1);
  });

  it('has no rows for a run that was not traced', () => {
    expect(analyze(loadCapture('hot-regex')).deopts.length).toBe(0);
  });
});

describe('the deopt table of the deopt-loop run', () => {
  const m = loadModel('deopt-loop');
  const price = () => {
    for (let i = 0; i < m.deopts.length; i++) {
      const fn = m.deopts.fn[i] ?? 0;
      if (
        m.strings[m.functions.name[fn] ?? 0] === 'price' &&
        m.strings[m.deopts.reason[i] ?? 0] === 'wrong map'
      )
        return i;
    }
    return -1;
  };

  it('says which process the trace came from, so a view can tell its own deopts apart', () => {
    const i = price();
    expect(m.strings[m.deopts.proc[i] ?? 0]).toBe(m.tracks[0]?.id);
  });

  it('has no source map here, so the original line is the generated line', () => {
    const i = price();
    expect(m.deopts.origLine[i]).toBe(m.deopts.line[i]);
  });
});

describe('the deopt table when the script has a source map', () => {
  const SHIFT = 100;
  const mapped = () => {
    const capture = structuredClone(loadCapture('deopt-loop'));
    const script = capture.tracks[0]?.scripts.find((s) => s.url.endsWith('deopt-loop.cjs'));
    if (!script) throw new Error('deopt-loop.cjs missing from the capture');
    const gen = new SourceMapGenerator({ file: 'deopt-loop.cjs' });
    for (let line = 1; line <= 60; line++) {
      gen.addMapping({
        generated: { line, column: 0 },
        original: { line: line + SHIFT, column: 0 },
        source: 'deopt-loop.ts',
      });
    }
    capture.sourceMaps[script.url] = gen.toString();
    script.sourceMapURL = 'deopt-loop.cjs.map';
    return analyze(capture);
  };

  it('reports the line in the original source, the one the source view shows', () => {
    const m = mapped();
    let checked = 0;
    for (let i = 0; i < m.deopts.length; i++) {
      const file = m.strings[m.functions.file[m.deopts.fn[i] ?? 0] ?? 0] ?? '';
      if (!file.endsWith('deopt-loop.ts')) continue;
      expect(m.deopts.origLine[i]).toBe((m.deopts.line[i] ?? 0) + SHIFT);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
