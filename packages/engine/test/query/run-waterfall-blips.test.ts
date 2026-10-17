import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import type { ExecutionModel } from '../../src/model.js';
import { describeFunction } from '../../src/query/view.js';
import type { WaterfallRow } from '../../src/query/types.js';
import { smallTaskLimitUs, waterfallForRun } from '../../src/query/waterfall.js';
import { loadModel } from '../helpers/fixtures.js';
import type { FixtureName } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';
import type { Step } from '../helpers/synth.js';

const rt = (name: string) => ({ name, url: 'node:internal/process/task_queues' });
const timer = { name: 'listOnTimeout', url: 'node:internal/timers' };
const PROGRAM = '(program)';
const argv = ['node', '/project/src/app.js'];

const nameOf = (m: ExecutionModel, r: WaterfallRow) =>
  r.fn < 0 ? '' : describeFunction(m, r.fn).name;
const topBlips = (m: ExecutionModel, rows: WaterfallRow[]) =>
  rows.filter((r) => r.kind === 'call' && r.depth === 1 && nameOf(m, r) === PROGRAM);
const summaries = (rows: WaterfallRow[]) => rows.filter((r) => r.kind === 'summary');

describe('runtime blips between tasks', () => {
  // Task A, a one-sample (program) pause, then task B: the stacks share nothing, so it cannot be bridged.
  const between = (blipSamples: number): Step[] => [
    { stack: ['main', 'work'], samples: 20 },
    { stack: [PROGRAM], samples: blipSamples },
    { stack: [rt('processTicksAndRejections'), 'later'], samples: 20 },
  ];

  it('folds a pause shorter than the small-task limit into a summary row', () => {
    const m = analyze(synthCapture(between(1), { argv }));
    const w = waterfallForRun(m, 0);
    expect(topBlips(m, w.rows)).toEqual([]);
    const [s] = summaries(w.rows);
    expect(s).toMatchObject({ kind: 'summary', depth: 1, summaryTasks: [] });
    expect(s?.summaryRuntimeUs).toBeCloseTo(1000, -2);
    expect(s?.label).toMatch(/^runtime pauses · ~1\.\d ms$/);
  });

  it('keeps a pause at or above the limit as a row of its own', () => {
    const m = analyze(synthCapture(between(10), { argv }));
    const w = waterfallForRun(m, 0);
    expect(topBlips(m, w.rows)).toHaveLength(1);
    expect(summaries(w.rows)).toEqual([]);
  });

  it('merges a pause and the small tasks next to it into one summary row', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: ['main', 'work'], samples: 20 },
          { stack: [PROGRAM], samples: 1 },
          { idle: 6 },
          { stack: [timer], samples: 1 },
          { idle: 6 },
          { stack: [rt('processTicksAndRejections'), 'later'], samples: 20 },
        ],
        { argv },
      ),
    );
    const w = waterfallForRun(m, 0);
    const list = summaries(w.rows);
    expect(list).toHaveLength(1);
    expect(list[0]?.summaryTasks).toHaveLength(1);
    expect(list[0]?.summaryRuntimeUs).toBeGreaterThan(0);
    expect(list[0]?.label).toMatch(/^1 small task · ~2\.\d ms$/);
  });

  it('makes one summary row per gap: a real task in between keeps them apart', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: ['main', 'work'], samples: 20 },
          { stack: [PROGRAM], samples: 1 },
          { stack: [rt('processTicksAndRejections'), 'middle'], samples: 20 },
          { stack: [PROGRAM], samples: 1 },
          { stack: [rt('runMicrotasks'), 'last'], samples: 20 },
        ],
        { argv },
      ),
    );
    expect(summaries(waterfallForRun(m, 0).rows)).toHaveLength(2);
  });

  it('keeps the root row the same length, folded or not', () => {
    const m = analyze(synthCapture(between(1), { argv }));
    const folded = waterfallForRun(m, 0).rows[0];
    const open = waterfallForRun(m, 0, { collapseTrivialUs: 0 }).rows[0];
    expect(folded?.durUs).toBe(open?.durUs);
  });

  it('does nothing when collapsing is off', () => {
    const m = analyze(synthCapture(between(1), { argv }));
    const w = waterfallForRun(m, 0, { collapseTrivialUs: 0 });
    expect(topBlips(m, w.rows)).toHaveLength(1);
    expect(summaries(w.rows)).toEqual([]);
  });

  it('counts only tasks in summaryTasks and gives other rows no runtime time', () => {
    const m = analyze(synthCapture(between(1), { argv }));
    const w = waterfallForRun(m, 0);
    expect(w.rows.filter((r) => r.kind !== 'summary').every((r) => r.summaryRuntimeUs === 0)).toBe(
      true,
    );
  });

  it('uses the larger of the small-task limit and two sampling intervals', () => {
    const m = analyze(synthCapture(between(1), { argv }));
    expect(smallTaskLimitUs(m, 0)).toBeGreaterThanOrEqual(500);
    expect(smallTaskLimitUs(m, 0, 0)).toBe(0);
    expect(smallTaskLimitUs(m, 0, 7000)).toBe(7000);
  });
});

describe('runtime blips on real captures', () => {
  it.each(['eslint-cli', 'eslint-cli-wrapped', 'orders-server', 'async-chain'] as FixtureName[])(
    '%s: no top-level (program) row is below the limit',
    (name) => {
      const m = loadModel(name);
      const t = m.primaryTrack;
      const limit = Math.max(smallTaskLimitUs(m, t), 2 * m.meta.precisionUs);
      const w = waterfallForRun(m, t);
      const blips = topBlips(m, w.rows);
      expect(blips.filter((r) => r.durUs < limit)).toEqual([]);
    },
  );

  it.each(['eslint-cli', 'orders-server'] as FixtureName[])(
    '%s: the root keeps its length and long pauses stay visible',
    (name) => {
      const m = loadModel(name);
      const t = m.primaryTrack;
      const folded = waterfallForRun(m, t);
      const open = waterfallForRun(m, t, { collapseTrivialUs: 0 });
      expect(folded.rows[0]?.durUs).toBeCloseTo(open.rows[0]?.durUs ?? 0, 0);
      const limit = Math.max(smallTaskLimitUs(m, t), 2 * m.meta.precisionUs);
      const longOpen = topBlips(m, open.rows).filter((r) => r.durUs >= limit).length;
      // Pauses inside small tasks go with those tasks, so the folded view never shows more.
      expect(topBlips(m, folded.rows).length).toBeLessThanOrEqual(longOpen);
    },
  );

  it('folds the pauses of eslint-cli into its summary rows', () => {
    const m = loadModel('eslint-cli');
    const w = waterfallForRun(m, m.primaryTrack);
    expect(summaries(w.rows).some((r) => r.summaryRuntimeUs > 0)).toBe(true);
  });
});
