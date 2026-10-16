import { describe, expect, it } from 'vitest';
import { TaskKind } from '../../src/model.js';
import { describeTasks } from '../../src/query/tasks.js';
import { trivialTasks } from '../../src/query/waterfall.js';
import { loadModel } from '../helpers/fixtures.js';

const GROUP_ORDER = [
  'Whole run',
  'Entry',
  'Requests',
  'Timers',
  'I/O',
  'Microtasks',
  'Other',
  'Small tasks',
];

describe('describeTasks on the eslint cli', () => {
  const m = loadModel('eslint-cli');
  const tasks = describeTasks(m, m.primaryTrack);
  const real = tasks.filter((t) => t.group !== 'Whole run');

  it('starts with the whole run, named after the entry script', () => {
    expect(tasks[0]).toMatchObject({
      group: 'Whole run',
      label: 'Whole run · eslint/bin/eslint.js',
      index: -1,
      trivial: false,
      longest: false,
    });
    expect(tasks[0]?.busyUs).toBe(m.tracks[m.primaryTrack]?.busyUs);
    expect(tasks[0]?.durationUs).toBeGreaterThan(1_500_000);
  });

  it('puts the entry script next, named explicitly', () => {
    expect(tasks[1]).toMatchObject({
      group: 'Entry',
      label: 'main · load eslint/bin/eslint.js',
      trivial: false,
    });
  });

  it('prefixes every task label with the kind of task, never a bare file name', () => {
    expect(
      real.every((t) => /^(main|request|timer|immediate|microtasks|I\/O|other) · \S/.test(t.label)),
    ).toBe(true);
  });

  it('lists groups in a fixed order', () => {
    const order = tasks.map((t) => GROUP_ORDER.indexOf(t.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('sorts tasks by duration, longest first, inside each group', () => {
    for (const group of GROUP_ORDER) {
      const durations = tasks.filter((t) => t.group === group).map((t) => t.durationUs);
      expect(durations).toEqual([...durations].sort((a, b) => b - a));
    }
  });

  it('flags exactly one longest task, among real tasks', () => {
    const longest = tasks.filter((t) => t.longest);
    expect(longest).toHaveLength(1);
    expect(longest[0]?.durationUs).toBe(Math.max(...real.map((t) => t.durationUs)));
  });

  it('points at real tasks of the track with their busy time', () => {
    const track = m.tracks[m.primaryTrack];
    expect(new Set(real.map((t) => t.index)).size).toBe(track?.tasks.length);
    const first = real.find((t) => t.group === 'Entry');
    expect(first?.busyUs).toBe(track?.tasks.busy[first?.index ?? 0]);
    expect(first?.startUs).toBe(track?.tasks.start[first?.index ?? 0]);
  });

  it('moves small tasks into their own group, the same ones the run waterfall folds', () => {
    const small = tasks.filter((t) => t.trivial);
    expect(small.length).toBeGreaterThan(5);
    expect(small.every((t) => t.group === 'Small tasks')).toBe(true);
    expect(tasks.filter((t) => t.group === 'Small tasks').every((t) => t.trivial)).toBe(true);
    const folded = trivialTasks(m, m.primaryTrack);
    expect(new Set(small.map((t) => t.index))).toEqual(folded);
  });

  it('never calls the entry task small', () => {
    expect(real.find((t) => t.group === 'Entry')?.trivial).toBe(false);
  });
});

describe('describeTasks on the orders server', () => {
  const m = loadModel('orders-server');
  const tasks = describeTasks(m, 0);

  it('groups requests with their route', () => {
    const requests = tasks.filter((t) => t.group === 'Requests');
    expect(requests.length).toBeGreaterThanOrEqual(14);
    expect(requests.every((t) => t.label === 'request · GET /orders')).toBe(true);
  });

  it('labels timers by their callback, small ones included', () => {
    const timer = tasks.find((t) => t.label === 'timer · flushMetrics');
    expect(timer).toBeDefined();
    expect(timer?.trivial).toBe(true);
    expect(timer?.group).toBe('Small tasks');
  });

  it('keeps the first main task as the entry', () => {
    expect(tasks.filter((t) => t.group === 'Entry')).toHaveLength(1);
    expect(tasks[0]?.group).toBe('Whole run');
    expect(tasks[1]?.label).toBe('main · load zoo/orders-server/dist/server.js');
  });

  it('agrees with the task table on request kinds', () => {
    const track = m.tracks[0];
    const requestTasks = Array.from({ length: track?.tasks.length ?? 0 }, (_, k) => k).filter(
      (k) => track?.tasks.kind[k] === TaskKind.Request,
    );
    const listed = tasks.filter((t) => t.label.startsWith('request · '));
    expect(listed).toHaveLength(requestTasks.length);
  });
});

describe('describeTasks errors', () => {
  it('names the missing track', () => {
    expect(() => describeTasks(loadModel('sync-io'), 99)).toThrow(/No track at index 99/);
  });
});
