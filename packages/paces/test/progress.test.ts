import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatElapsed, progressLine, startProgress } from '../src/progress.js';

describe('formatElapsed', () => {
  it.each([
    [0, '0:00'],
    [9_400, '0:09'],
    [65_000, '1:05'],
    [3_599_000, '59:59'],
    [3_723_000, '1:02:03'],
  ])('%d ms is %s', (ms, text) => {
    expect(formatElapsed(ms)).toBe(text);
  });
});

describe('progressLine', () => {
  it('says it is still profiling, for how long, and how to stop', () => {
    expect(progressLine(25_000, { processes: 2, marks: 0, keys: false })).toBe(
      'paces: still profiling · 0:25 · 2 processes · Ctrl+C stops and shows the results',
    );
  });

  it('lists the hotkeys and the marks so far when they are on', () => {
    expect(progressLine(61_000, { processes: 1, marks: 1, keys: true })).toBe(
      'paces: still profiling · 1:01 · 1 process · 1 mark · m add a mark · s stop and show results · Ctrl+C stops and shows the results',
    );
  });

  it('leaves the process count out until a process has reported in', () => {
    // A program busy from its first line cannot answer on the control socket yet; that is not a hang.
    expect(progressLine(6_000, { processes: 0, marks: 0, keys: false })).toBe(
      'paces: still profiling · 0:06 · Ctrl+C stops and shows the results',
    );
  });
});

describe('startProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const state = { processes: 1, marks: 0, keys: false };

  it('stays quiet for a short run, then reports at 5 s and every 10 s after', () => {
    const log = vi.fn();
    startProgress({ log, state: () => state, now: () => Date.now() });
    vi.advanceTimersByTime(4_000);
    expect(log).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(log).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(9_000);
    expect(log).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]?.[0]).toContain('0:15');
  });

  it('reads the state fresh each time', () => {
    const log = vi.fn();
    const live = { processes: 1, marks: 0, keys: true };
    startProgress({ log, state: () => live, now: () => Date.now() });
    vi.advanceTimersByTime(5_000);
    live.marks = 2;
    vi.advanceTimersByTime(10_000);
    expect(log.mock.calls[1]?.[0]).toContain('2 marks');
  });

  it('stops reporting once stopped', () => {
    const log = vi.fn();
    const stop = startProgress({ log, state: () => state, now: () => Date.now() });
    stop();
    vi.advanceTimersByTime(60_000);
    expect(log).not.toHaveBeenCalled();
  });
});
