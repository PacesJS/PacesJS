import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { loadCapture } from '../helpers/capture.js';
import { loadModel } from '../helpers/fixtures.js';

const deoptFindings = () => loadModel('deopt-loop').findings.filter((f) => f.kind === 'v8-deopt');

describe('the v8-deopt finding on the deopt-loop run', () => {
  it('flags the hot function that keeps getting deoptimized, and only that one', () => {
    const [finding, ...rest] = deoptFindings();
    expect(rest).toEqual([]);
    expect(finding?.summary).toMatch(
      /^In price \(.*deopt-loop\.cjs:5\), V8 threw away optimized code 10 times for "wrong map"; the function takes \d+(\.\d)?% of CPU time\.$/,
    );
  });

  it('points at the function it blames', () => {
    const m = loadModel('deopt-loop');
    const finding = deoptFindings()[0];
    const fn = finding?.evidence[0] ?? 0;
    expect(m.strings[m.functions.name[fn] ?? 0]).toBe('price');
    expect(finding?.showMe).toMatchObject({ view: 'functions', fn });
  });

  it('says how to fix the reason', () => {
    expect(deoptFindings()[0]?.hint).toContain('same properties in the same order');
  });

  it('is not a high severity: V8 reports that it deoptimized, not what that cost', () => {
    expect(deoptFindings()[0]?.severity).not.toBe('high');
  });

  it('echoes its thresholds in the rule', () => {
    expect(deoptFindings()[0]?.rule).toMatch(/at least 3 times/);
    expect(deoptFindings()[0]?.rule).toMatch(/5\.0%/);
  });

  it('ignores on-stack-replacement churn and one-off deopts of the hot caller', () => {
    const m = loadModel('deopt-loop');
    const named = deoptFindings().map((f) => m.strings[m.functions.name[f.evidence[0] ?? 0] ?? 0]);
    expect(named).not.toContain('total');
  });

  it('needs the deopt count from the options, not a constant', () => {
    const m = analyze(loadCapture('deopt-loop'), { thresholds: { deoptMinCount: 11 } });
    expect(m.findings.filter((f) => f.kind === 'v8-deopt')).toEqual([]);
  });

  it('needs the function to be hot', () => {
    const m = analyze(loadCapture('deopt-loop'), { thresholds: { deoptMinShare: 0.5 } });
    expect(m.findings.filter((f) => f.kind === 'v8-deopt')).toEqual([]);
  });
});

describe('everything the deopt-loop run produces', () => {
  // The V8 finding needs a hot function, so the hot-function findings for `total` and `price` come
  // with it; they are the same two functions the deopts are about.
  it('is the two hot functions and the deopt finding', () => {
    expect(loadModel('deopt-loop').findings.map((f) => f.kind)).toEqual([
      'hot-function',
      'hot-function',
      'v8-deopt',
    ]);
  });
});

describe('a deopt kind the engine does not know', () => {
  it('is not counted as an eager deopt', () => {
    const capture = structuredClone(loadCapture('deopt-loop'));
    for (const track of capture.tracks) {
      track.deoptTrace = track.deoptTrace?.replaceAll('deopt-eager', 'deopt-strange');
    }
    const m = analyze(capture);
    expect(m.findings.filter((f) => f.kind === 'v8-deopt')).toEqual([]);
  });
});
