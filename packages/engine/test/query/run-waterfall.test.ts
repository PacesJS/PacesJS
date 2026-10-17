import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import type { ExecutionModel } from '../../src/model.js';
import { Origin } from '../../src/model.js';
import type { Waterfall, WaterfallRow } from '../../src/query/types.js';
import { describeFunction } from '../../src/query/view.js';
import { waterfallForRun } from '../../src/query/waterfall.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';
import type { Step } from '../helpers/synth.js';

const rt = (name: string) => ({ name, url: 'node:internal/process/task_queues' });
const timer = { name: 'listOnTimeout', url: 'node:internal/timers' };
const argv = ['node', '/project/src/app.js'];

const nameOf = (m: ExecutionModel, r: WaterfallRow) =>
  r.fn < 0 ? '' : describeFunction(m, r.fn).name;
const consistent = (w: Waterfall): boolean =>
  w.rows.every((r, i) => r.id === i && r.parent < r.id) &&
  w.criticalPath.every((id) => w.rows[id]?.critical === true);

const asyncChain: Step[] = [
  { stack: ['main', 'run', 'readAndVerify'], samples: 3 },
  { stack: ['main', 'run'], samples: 1 },
  { idle: 6 },
  { stack: [rt('processTicksAndRejections'), 'readAndVerify', 'verify'], samples: 4 },
  { stack: [rt('processTicksAndRejections'), 'run', 'reporter'], samples: 2 },
  { idle: 3 },
];

describe('waterfallForRun on an async chain', () => {
  const m = analyze(synthCapture(asyncChain, { argv }));
  const w = waterfallForRun(m, 0);
  const calls = w.rows.filter((r) => r.kind === 'call');

  it('has one root row named after the entry script, covering the whole run', () => {
    const [root] = w.rows;
    expect(root).toMatchObject({ depth: 0, parent: -1, kind: 'call' });
    expect(nameOf(m, root as WaterfallRow)).toBe('src/app.js');
    expect(calls.filter((r) => r.depth === 0)).toHaveLength(1);
    expect(root?.durUs).toBeGreaterThan(15_000);
    expect(root?.share).toBeCloseTo(1, 2);
  });

  it('nests the logical calls: main, run, readAndVerify, verify', () => {
    const depthOf = (name: string) => calls.find((r) => nameOf(m, r) === name)?.depth;
    expect([depthOf('main'), depthOf('run'), depthOf('readAndVerify'), depthOf('verify')]).toEqual([
      1, 2, 3, 4,
    ]);
    expect(calls.find((r) => nameOf(m, r) === 'reporter')?.depth).toBe(3);
  });

  it('draws the resumed call as another segment, flagged, and its callers as one row each', () => {
    const segments = (name: string) => calls.filter((r) => nameOf(m, r) === name);
    expect(segments('readAndVerify').map((r) => r.resumed)).toEqual([false, true]);
    expect(segments('run').map((r) => r.resumed)).toEqual([false]);
    expect(segments('main')).toHaveLength(1);
    expect(segments('verify').map((r) => r.resumed)).toEqual([false]);
  });

  it('puts an idle awaiting row, with its duration, between the segments', () => {
    const waits = w.rows.filter((r) => r.kind === 'wait');
    expect(waits).toHaveLength(1);
    const [wait] = waits;
    expect(wait?.label).toMatch(/^awaiting ~7\.\d ms$/);
    expect(wait?.durUs).toBeCloseTo(7000, -3);
    // A sibling right before the resumed segment, inside its caller's row.
    const resumed = calls.find((r) => nameOf(m, r) === 'readAndVerify' && r.resumed);
    expect(wait?.depth).toBe(resumed?.depth);
    expect(wait?.parent).toBe(resumed?.parent);
    expect(wait?.end).toBeCloseTo(resumed?.start ?? 0, -2);
  });

  it('keeps ids as indexes, parents before children, and a critical path', () => {
    expect(consistent(w)).toBe(true);
    expect(w.criticalPath.length).toBeGreaterThan(2);
  });

  it('flags only the resumed segment, not the callers that continue with it', () => {
    expect(calls.filter((r) => r.resumed).map((r) => nameOf(m, r))).toEqual(['readAndVerify']);
  });
});

describe('waterfallForRun and small tasks', () => {
  const steps: Step[] = [
    { stack: ['main', 'work'], samples: 20 },
    { idle: 8 },
    { stack: [timer], samples: 1 },
    { idle: 8 },
    { stack: [timer], samples: 1 },
    { idle: 8 },
    { stack: [rt('processTicksAndRejections'), 'tiny'], samples: 1 },
    { idle: 8 },
    { stack: [rt('processTicksAndRejections'), 'bigger'], samples: 12 },
    { idle: 8 },
    { stack: [timer], samples: 1 },
  ];
  const m = analyze(synthCapture(steps, { argv }));
  const summaries = (w: Waterfall) => w.rows.filter((r) => r.kind === 'summary');

  it('makes no rows for tasks that only run runtime frames, one summary row per gap instead', () => {
    const w = waterfallForRun(m, 0);
    expect(w.rows.some((r) => nameOf(m, r) === 'listOnTimeout')).toBe(false);
    expect(summaries(w).map((r) => r.label)).toEqual([
      expect.stringMatching(/^2 small tasks · ~2\.\d ms$/),
      expect.stringMatching(/^1 small task · ~1\.\d ms$/),
    ]);
  });

  it('keeps summary rows under the root, with the tasks they stand for', () => {
    const w = waterfallForRun(m, 0);
    const [first] = summaries(w);
    expect(first).toMatchObject({ depth: 1, parent: 0, kind: 'summary' });
    expect(first?.summaryTasks).toEqual([1, 2]);
    expect(
      w.rows.filter((r) => r.kind !== 'summary').every((r) => r.summaryTasks.length === 0),
    ).toBe(true);
  });

  it('keeps a task with real work of its own as ordinary rows', () => {
    const w = waterfallForRun(m, 0);
    expect(w.rows.some((r) => nameOf(m, r) === 'bigger')).toBe(true);
    expect(w.rows.some((r) => nameOf(m, r) === 'tiny')).toBe(true);
  });

  it('treats shorter tasks as small when asked', () => {
    const w = waterfallForRun(m, 0, { collapseTrivialUs: 5000 });
    expect(w.rows.some((r) => nameOf(m, r) === 'tiny')).toBe(false);
    expect(summaries(w).some((r) => r.summaryTasks.includes(3))).toBe(true);
  });

  it('can be told not to collapse anything', () => {
    const w = waterfallForRun(m, 0, { collapseTrivialUs: 0 });
    expect(summaries(w)).toEqual([]);
  });

  it('honors the waterfall options on top', () => {
    const w = waterfallForRun(m, 0, { sort: 'duration', minDurationUs: 3000 });
    expect(consistent(w)).toBe(true);
    expect(w.rows.every((r) => r.durUs >= 3000)).toBe(true);
  });

  it('rejects a track that does not exist', () => {
    expect(() => waterfallForRun(m, 9)).toThrow(/No track at index 9/);
  });
});

describe('waterfallForRun on real captures', () => {
  const eslint = loadModel('eslint-cli');
  const w = waterfallForRun(eslint, eslint.primaryTrack);

  it('starts at the eslint entry', () => {
    expect(nameOf(eslint, w.rows[0] as WaterfallRow)).toBe('eslint/bin/eslint.js');
    expect(w.rows.filter((r) => r.kind === 'call' && r.depth === 0)).toHaveLength(1);
  });

  it('rolls the small tasks into summary rows instead of one row each', () => {
    const summaries = w.rows.filter((r) => r.kind === 'summary');
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    expect(
      summaries.every(
        (r) => (r.summaryTasks.length >= 1 || r.summaryRuntimeUs > 0) && r.depth === 1,
      ),
    ).toBe(true);
    const track = eslint.tracks[eslint.primaryTrack];
    const runtimeOnly = Array.from(track?.tasks.runtimeOnly ?? [], (v, k) =>
      v === 1 ? k : -1,
    ).filter((k) => k >= 0);
    const covered = new Set(summaries.flatMap((r) => r.summaryTasks));
    expect(runtimeOnly.every((k) => covered.has(k))).toBe(true);
  });

  it('shows readAndVerifyFile inside the logical chain', () => {
    const row = w.rows.find((r) => nameOf(eslint, r) === 'readAndVerifyFile');
    expect(row?.depth).toBeGreaterThan(3);
    const chain: string[] = [];
    for (let p = row?.parent ?? -1; p >= 0; p = w.rows[p]?.parent ?? -1) {
      chain.push(nameOf(eslint, w.rows[p] as WaterfallRow));
    }
    expect(chain).toContain('lintFiles');
  });

  it('is consistent and bounded in size', () => {
    expect(consistent(w)).toBe(true);
    expect(w.rows.length).toBeLessThan(2500);
  });

  it('hides origins like the task waterfall', () => {
    const hidden = waterfallForRun(eslint, eslint.primaryTrack, {
      hideOrigins: [Origin.Dependency],
    });
    expect(hidden.rows.some((r) => r.fn >= eslint.functions.length)).toBe(false);
    expect(consistent(hidden)).toBe(true);
  });
});

describe('waterfallForRun on async-chain', () => {
  const m = loadModel('async-chain');
  const w = waterfallForRun(m, m.primaryTrack);
  const readRows = w.rows.filter((r) => r.kind === 'call' && nameOf(m, r) === 'readAndVerify');

  it('shows readAndVerify as one call with resumed segments and awaiting rows between them', () => {
    // Awaits shorter than one sampling interval do not split a call, so segments merge.
    expect(readRows.length).toBeGreaterThanOrEqual(2);
    expect(readRows.some((r) => r.resumed)).toBe(true);
    expect(w.rows.filter((r) => r.kind === 'wait').length).toBeGreaterThanOrEqual(1);
  });

  it('puts every segment under the same logical ancestors', () => {
    const path = (r: WaterfallRow): string[] => {
      const out: string[] = [];
      for (let p = r.parent; p >= 0; p = w.rows[p]?.parent ?? -1) {
        out.push(nameOf(m, w.rows[p] as WaterfallRow));
      }
      return out;
    };
    const paths = new Set(readRows.map((r) => path(r).join('<')));
    expect(paths.size).toBe(1);
    expect([...paths][0]?.startsWith('run<main<')).toBe(true);
  });
});
