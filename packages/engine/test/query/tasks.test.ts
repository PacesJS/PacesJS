import { describe, expect, it } from 'vitest';
import { describeTasks } from '../../src/query/tasks.js';
import { TaskKind } from '../../src/model.js';
import { loadModel } from '../helpers/fixtures.js';

const GROUP_ORDER = ['Entry', 'Requests', 'Timers', 'I/O', 'Microtasks', 'Other'];

describe('describeTasks on the eslint cli', () => {
  const m = loadModel('eslint-cli');
  const tasks = describeTasks(m, m.primaryTrack);

  it('puts the entry script first, named explicitly', () => {
    expect(tasks[0]).toMatchObject({
      group: 'Entry',
      label: 'main · load eslint/bin/eslint.js',
    });
  });

  it('prefixes every label with the kind of task, never a bare file name', () => {
    expect(
      tasks.every((t) =>
        /^(main|request|timer|immediate|microtasks|I\/O|other) · \S/.test(t.label),
      ),
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

  it('flags exactly one longest task', () => {
    const longest = tasks.filter((t) => t.longest);
    expect(longest).toHaveLength(1);
    expect(longest[0]?.durationUs).toBe(Math.max(...tasks.map((t) => t.durationUs)));
  });

  it('points at real tasks of the track with their busy time', () => {
    const track = m.tracks[m.primaryTrack];
    expect(new Set(tasks.map((t) => t.index)).size).toBe(track?.tasks.length);
    const first = tasks[0];
    expect(first?.busyUs).toBe(track?.tasks.busy[first?.index ?? 0]);
    expect(first?.startUs).toBe(track?.tasks.start[first?.index ?? 0]);
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

  it('labels timers by their callback', () => {
    const timer = tasks.find((t) => t.group === 'Timers');
    expect(timer?.label).toBe('timer · flushMetrics');
  });

  it('keeps the first main task as the entry and any other startup work under Other', () => {
    expect(tasks.filter((t) => t.group === 'Entry')).toHaveLength(1);
    expect(tasks[0]?.label).toBe('main · load zoo/orders-server/dist/server.js');
  });

  it('agrees with the task table on kinds', () => {
    const tracks = m.tracks[0];
    const requestTasks = Array.from({ length: tracks?.tasks.length ?? 0 }, (_, k) => k).filter(
      (k) => tracks?.tasks.kind[k] === TaskKind.Request,
    );
    expect(tasks.filter((t) => t.group === 'Requests')).toHaveLength(requestTasks.length);
  });
});

describe('describeTasks errors', () => {
  it('names the missing track', () => {
    expect(() => describeTasks(loadModel('sync-io'), 99)).toThrow(/No track at index 99/);
  });
});
