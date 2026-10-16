import { describe, expect, it } from 'vitest';
import { TaskKind } from '../../src/model.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';
import { analyze } from '../../src/analyze.js';

const label = (m: ReturnType<typeof loadModel>, trackIndex: number, task: number) =>
  m.strings[m.tracks[trackIndex]?.tasks.label[task] ?? 0];

describe('task segmentation on the orders server', () => {
  const m = loadModel('orders-server');
  const main = m.tracks[0];

  it('labels request tasks from the request events aligned by time', () => {
    const tasks = main?.tasks;
    const requestTasks = Array.from({ length: tasks?.length ?? 0 }, (_, k) => k).filter(
      (k) => tasks?.kind[k] === TaskKind.Request,
    );
    expect(requestTasks.length).toBeGreaterThanOrEqual(14);
    expect(new Set(requestTasks.map((k) => label(m, 0, k)))).toEqual(new Set(['GET /orders']));
  });

  it('puts the root-level getOrders continuation of every request inside a request task', () => {
    const spans = main?.spans;
    const tasks = main?.tasks;
    const getOrders = m.strings.indexOf('getOrders');
    const inRequestTasks = Array.from({ length: spans?.length ?? 0 }, (_, s) => s).filter((s) => {
      if (spans?.depth[s] !== 0 || m.functions.name[spans.fn[s] ?? 0] !== getOrders) return false;
      const t = Array.from({ length: tasks?.length ?? 0 }, (_, k) => k).find(
        (k) => (tasks?.spanStart[k] ?? 0) <= s && s < (tasks?.spanEnd[k] ?? 0),
      );
      return t !== undefined && tasks?.kind[t] === TaskKind.Request;
    });
    expect(inRequestTasks.length).toBe(14);
  });

  it('keeps each request about 200 ms as one task', () => {
    const tasks = main?.tasks;
    const longest = Math.max(
      ...Array.from({ length: tasks?.length ?? 0 }, (_, k) =>
        tasks?.kind[k] === TaskKind.Request
          ? ((tasks.end[k] ?? 0) - (tasks.start[k] ?? 0)) / 1000
          : 0,
      ),
    );
    expect(longest).toBeGreaterThan(150);
    expect(longest).toBeLessThan(260);
  });

  it('classifies startup work as main and labels timers by their callback', () => {
    const kinds = Array.from({ length: main?.tasks.length ?? 0 }, (_, k) => main?.tasks.kind[k]);
    expect(kinds).toContain(TaskKind.Main);
    const timer = Array.from({ length: main?.tasks.length ?? 0 }, (_, k) => k).find(
      (k) => main?.tasks.kind[k] === TaskKind.Timer,
    );
    expect(label(m, 0, timer ?? 0)).toBe('timer · flushMetrics');
  });

  it('treats ESM evaluation inside a microtask as startup work in a worker', () => {
    const worker = m.tracks[1];
    const longest = Math.max(...Array.from(worker?.tasks.busy ?? []));
    const k = Array.from(worker?.tasks.busy ?? []).indexOf(longest);
    expect(worker?.tasks.kind[k]).toBe(TaskKind.Main);
    expect(longest / 1000).toBeGreaterThan(1000);
  });

  it('points each task at a contiguous range of spans', () => {
    const tasks = main?.tasks;
    expect(tasks?.spanStart[0]).toBeLessThanOrEqual(tasks?.spanEnd[0] ?? 0);
    for (let k = 1; k < (tasks?.length ?? 0); k++) {
      expect(tasks?.start[k] ?? 0).toBeGreaterThanOrEqual(tasks?.end[k - 1] ?? 0);
    }
  });
});

describe('task segmentation without idle samples', () => {
  const m = loadModel('sync-io');

  it('splits 30 back-to-back requests instead of merging them into one long task', () => {
    const tasks = m.tracks[0]?.tasks;
    const requestTasks = Array.from({ length: tasks?.length ?? 0 }, (_, k) => k).filter(
      (k) => tasks?.kind[k] === TaskKind.Request,
    );
    expect(requestTasks.length).toBeGreaterThanOrEqual(30);
    expect(
      Math.max(...requestTasks.map((k) => ((tasks?.end[k] ?? 0) - (tasks?.start[k] ?? 0)) / 1000)),
    ).toBeLessThan(15);
  });
});

describe('task segmentation edge cases', () => {
  it('ends a task at an idle gap and starts the next one after it', () => {
    const m = analyze(
      synthCapture([{ stack: ['a'], samples: 3 }, { idle: 4 }, { stack: ['a'], samples: 2 }]),
    );
    const tasks = m.tracks[0]?.tasks;
    expect(tasks?.length).toBe(2);
    expect(Array.from(tasks?.busy ?? [])).toEqual([3000, 2000]);
  });

  it('keeps GC samples inside the task they interrupt', () => {
    const m = analyze(
      synthCapture([
        { stack: ['a'], samples: 2 },
        { stack: ['(garbage collector)'], samples: 1 },
        { stack: ['a'], samples: 2 },
      ]),
    );
    expect(m.tracks[0]?.tasks.length).toBe(1);
  });
});
