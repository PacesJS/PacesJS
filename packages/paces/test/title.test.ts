import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTitle, titleSequence } from '../src/title.js';

describe('titleSequence', () => {
  it('sets the terminal title with an hourglass that flips each second', () => {
    expect(titleSequence(0)).toBe('\u001b]0;⏳ paces · profiling 0:00\u0007');
    expect(titleSequence(1_000)).toBe('\u001b]0;⌛ paces · profiling 0:01\u0007');
    expect(titleSequence(2_000)).toContain('⏳');
  });
});

describe('startTitle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes at once, then every second, and clears the title when stopped', () => {
    const write = vi.fn();
    const stop = startTitle({ write, now: () => Date.now() });
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3_000);
    expect(write).toHaveBeenCalledTimes(4);
    expect(write.mock.calls[3]?.[0]).toContain('0:03');
    stop();
    expect(write).toHaveBeenLastCalledWith('\u001b]0;\u0007');
    vi.advanceTimersByTime(5_000);
    expect(write).toHaveBeenCalledTimes(5);
  });
});
