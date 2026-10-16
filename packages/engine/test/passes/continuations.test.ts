import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import type { ExecutionModel } from '../../src/model.js';
import type { RuntimeEvent } from '../../src/raw.js';
import { synthCapture } from '../helpers/synth.js';
import type { Step } from '../helpers/synth.js';

const rt = (name: string) => ({ name, url: 'node:internal/process/task_queues' });
const nameOfSpan = (m: ExecutionModel, span: number) =>
  m.strings[m.functions.name[m.tracks[0]?.spans.fn[span] ?? 0] ?? 0];

// Task 0: main -> run -> readAndVerify, then run alone; idle; task 1 resumes readAndVerify and then run.
const asyncChain: Step[] = [
  { stack: ['main', 'run', 'readAndVerify'], samples: 3 },
  { stack: ['main', 'run'], samples: 1 },
  { idle: 6 },
  { stack: [rt('processTicksAndRejections'), 'readAndVerify', 'verify'], samples: 4 },
  { stack: [rt('processTicksAndRejections'), 'run', 'reporter'], samples: 2 },
  { idle: 3 },
];

describe('inferred continuation stitching', () => {
  const m = analyze(synthCapture(asyncChain));
  const t = m.tracks[0];
  const c = t?.continuations;

  it('finds one resumed segment per distinct resumed function in a task', () => {
    expect(c?.length).toBe(2);
    expect(Array.from(c?.task ?? [])).toEqual([1, 1]);
    const names = Array.from(c?.fn ?? [], (f) => m.strings[m.functions.name[f] ?? 0]);
    expect(names).toEqual(['readAndVerify', 'run']);
  });

  it('parents a resumed function under the parent of its earlier call', () => {
    const parents = Array.from(c?.parentSpan ?? [], (s) => nameOfSpan(m, s));
    expect(parents).toEqual(['run', 'main']);
  });

  it('records the earlier call it resumes and the time spent awaiting', () => {
    const resumed = Array.from(c?.resumeOf ?? [], (s) => nameOfSpan(m, s));
    expect(resumed).toEqual(['readAndVerify', 'run']);
    expect(c?.waitUs[0]).toBeCloseTo(7000, -3);
    expect(c?.waitUs[1]).toBeCloseTo(10000, -3);
    expect(Array.from(c?.stitch ?? [])).toEqual([1, 1]);
  });

  it('summarizes the first segment on the task table', () => {
    const k = 1;
    expect(t?.tasks.stitch[k]).toBe(1);
    expect(nameOfSpan(m, t?.tasks.parentSpan[k] ?? 0)).toBe('run');
    expect(m.strings[m.functions.name[t?.tasks.resumedFn[k] ?? 0] ?? 0]).toBe('readAndVerify');
    expect(t?.tasks.waitUs[k]).toBeCloseTo(7000, -3);
  });

  it('leaves the entry task alone', () => {
    expect(t?.tasks.stitch[0]).toBe(0);
    expect(t?.tasks.parentSpan[0]).toBe(-1);
    expect(t?.tasks.resumedFn[0]).toBeGreaterThanOrEqual(0);
  });
});

describe('continuation chains', () => {
  const steps: Step[] = [
    { stack: ['main', 'run', 'readAndVerify'], samples: 2 },
    { idle: 5 },
    { stack: [rt('processTicksAndRejections'), 'readAndVerify'], samples: 2 },
    { idle: 5 },
    { stack: [rt('processTicksAndRejections'), 'readAndVerify'], samples: 2 },
  ];
  const m = analyze(synthCapture(steps));
  const t = m.tracks[0];

  it('stitches a later resumption to the same logical parent through the earlier resumption', () => {
    expect(Array.from(t?.tasks.stitch ?? [])).toEqual([0, 1, 1]);
    expect(nameOfSpan(m, t?.tasks.parentSpan[2] ?? 0)).toBe('run');
    expect(t?.tasks.parentSpan[2]).toBe(t?.tasks.parentSpan[1]);
  });

  it('prefers the latest earlier segment as the one being resumed', () => {
    const resumed = t?.tasks.resumeOf;
    expect(resumed?.[2]).not.toBe(resumed?.[1]);
    expect(t?.spans.start[resumed?.[2] ?? 0]).toBeGreaterThan(
      t?.spans.start[resumed?.[1] ?? 0] ?? 0,
    );
  });
});

describe('guards against false stitches', () => {
  it('does not stitch different functions that only share a name', () => {
    const other = { name: 'readAndVerify', url: 'file:///project/src/other.js' };
    const m = analyze(
      synthCapture([
        { stack: ['main', 'run', 'readAndVerify'], samples: 2 },
        { idle: 5 },
        { stack: [rt('processTicksAndRejections'), other], samples: 2 },
      ]),
    );
    expect(m.tracks[0]?.tasks.stitch[1]).toBe(0);
    expect(m.tracks[0]?.tasks.parentSpan[1]).toBe(-1);
    expect(m.tracks[0]?.continuations.length).toBe(0);
  });

  it('does not stitch to an earlier call that was a root, with no caller to attach to', () => {
    const m = analyze(
      synthCapture([
        { stack: ['readAndVerify'], samples: 2 },
        { idle: 5 },
        { stack: [rt('processTicksAndRejections'), 'readAndVerify'], samples: 2 },
      ]),
    );
    expect(m.tracks[0]?.tasks.stitch[1]).toBe(0);
  });

  it('does not stitch a function that never ran before', () => {
    const m = analyze(
      synthCapture([
        { stack: ['main'], samples: 2 },
        { idle: 5 },
        { stack: [rt('processTicksAndRejections'), 'fresh'], samples: 2 },
      ]),
    );
    expect(m.tracks[0]?.tasks.stitch[1]).toBe(0);
  });

  it('marks tasks that only contain runtime frames', () => {
    const m = analyze(
      synthCapture([
        { stack: ['main'], samples: 2 },
        { idle: 5 },
        { stack: [{ name: 'listOnTimeout', url: 'node:internal/timers' }], samples: 1 },
      ]),
    );
    expect(m.tracks[0]?.tasks.runtimeOnly[1]).toBe(1);
    expect(m.tracks[0]?.tasks.runtimeOnly[0]).toBe(0);
    expect(m.tracks[0]?.tasks.resumedFn[1]).toBe(-1);
  });
});

describe('exact stitching from async hooks', () => {
  const T0 = 1_800_000_000_000;
  const ev = (ms: number, phase: 'init' | 'before' | 'after', id: number): RuntimeEvent => ({
    type: 'async',
    time: T0 + ms,
    phase,
    asyncId: id,
    triggerAsyncId: 1,
    asyncType: 'PROMISE',
  });
  const m = analyze(
    synthCapture(
      [
        { stack: ['main', 'run', 'work'], samples: 5 },
        { idle: 5 },
        { stack: [rt('processTicksAndRejections'), 'work'], samples: 5 },
      ],
      { events: [ev(3, 'init', 2), ev(12, 'before', 2), ev(14, 'after', 2)] },
    ),
  );

  it('prefers a real async edge over inference and marks it exact', () => {
    expect(m.tracks[0]?.tasks.stitch[1]).toBe(2);
    expect(Array.from(m.tracks[0]?.continuations.stitch ?? [])).toEqual([2]);
    expect(nameOfSpan(m, m.tracks[0]?.tasks.parentSpan[1] ?? 0)).toBe('run');
  });
});
