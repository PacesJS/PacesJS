import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyInput } from '../src/keys.js';
import type { ProfileControls } from '../src/profile.js';
import { attachTerminal } from '../src/terminal.js';

class FakeInput extends EventEmitter implements KeyInput {
  isTTY = true;
  raw: boolean[] = [];
  setRawMode(on: boolean): this {
    this.raw.push(on);
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  press(key: string): void {
    this.emit('data', Buffer.from(key));
  }
}

function fakeControls() {
  const listeners: Array<() => void> = [];
  let used = false;
  const controls: ProfileControls = {
    mark: vi.fn(() => ({ at: 1, label: 'Mark 1' })),
    stop: vi.fn(),
    interrupt: vi.fn(),
    togglePause: vi.fn(),
    state: () => ({ processes: 1, marks: 0 }),
    stdinUsed: () => used,
    onStdinUsed: (l) => {
      listeners.push(l);
    },
  };
  return {
    controls,
    useStdin: () => {
      used = true;
      for (const l of listeners) l();
    },
  };
}

describe('attachTerminal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = (flag: boolean | undefined, over: { isTTY?: boolean } = {}) => {
    const title = vi.fn();
    const input = new FakeInput();
    const log = vi.fn();
    const c = fakeControls();
    const detach = attachTerminal({
      controls: c.controls,
      flag,
      input,
      isTTY: over.isTTY ?? true,
      log,
      title,
    });
    return { input, log, title, detach, ...c };
  };

  it('with --keys, takes the keys at once and says which they are', () => {
    const { input, log } = setup(true);
    expect(input.raw).toEqual([true]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/m.*mark.*s.*stop/i));
  });

  it('sends p to pause or resume a run that can be paused', () => {
    const { input, controls } = setup(undefined);
    input.press('p');
    expect(controls.togglePause).toHaveBeenCalledTimes(1);
  });

  it('ignores p for a run that cannot be paused', () => {
    const { input, controls } = setup(undefined);
    delete (controls as { togglePause?: unknown }).togglePause;
    expect(() => input.press('p')).not.toThrow();
  });

  it('sends m to mark, s to stop and Ctrl+C to interrupt', () => {
    const { input, controls } = setup(true);
    input.press('m');
    input.press('s');
    input.press('\u0003');
    expect(controls.mark).toHaveBeenCalledTimes(1);
    expect(controls.stop).toHaveBeenCalledTimes(1);
    expect(controls.interrupt).toHaveBeenCalledTimes(1);
  });

  it('without a flag, takes the keys at once on a terminal', () => {
    const { input } = setup(undefined);
    expect(input.raw).toEqual([true]);
  });

  it('tells a program that reads stdin how to get the keyboard, once, and keeps the keys', () => {
    const { input, log, useStdin } = setup(undefined);
    log.mockClear();
    useStdin();
    expect(input.raw).toEqual([true]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/reads stdin.*--no-keys/));
  });

  it('says nothing about stdin when the keys are off', () => {
    const { log, useStdin } = setup(false);
    useStdin();
    expect(log).not.toHaveBeenCalled();
  });

  it('with --no-keys, never touches the keyboard', () => {
    const { input } = setup(false);
    vi.advanceTimersByTime(10_000);
    expect(input.raw).toEqual([]);
  });

  it('without a terminal, takes nothing, and --keys says why', () => {
    const auto = setup(undefined, { isTTY: false });
    vi.advanceTimersByTime(10_000);
    expect(auto.input.raw).toEqual([]);
    const forced = setup(true, { isTTY: false });
    expect(forced.input.raw).toEqual([]);
    expect(forced.log).toHaveBeenCalledWith(expect.stringMatching(/--keys needs a terminal/));
  });

  it('restores the terminal and stops the timers when detached', () => {
    const { input, log, detach } = setup(true);
    detach();
    expect(input.raw).toEqual([true, false]);
    log.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(log).not.toHaveBeenCalled();
  });

  it('says the profile is still running on a long run, with the hotkeys listed when on', () => {
    const { log } = setup(true);
    log.mockClear();
    vi.advanceTimersByTime(5_000);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/still profiling.*m add a mark.*s stop/),
    );
  });

  it('animates the title on a terminal, and clears it when detached', () => {
    const { title, detach } = setup(false);
    expect(title).toHaveBeenCalledWith(expect.stringContaining('paces · profiling'));
    detach();
    expect(title).toHaveBeenLastCalledWith(']0;');
  });

  it('leaves the title alone without a terminal', () => {
    const { title } = setup(false, { isTTY: false });
    expect(title).not.toHaveBeenCalled();
  });

  describe('with the panel', () => {
    const withPanel = (size: { rows: number | undefined; cols: number | undefined }) => {
      const input = new FakeInput();
      const log = vi.fn();
      const written: string[] = [];
      const c = fakeControls();
      const detach = attachTerminal({
        controls: c.controls,
        flag: false,
        input,
        isTTY: true,
        log,
        title: vi.fn(),
        panel: {
          write: (s) => written.push(s),
          size: () => size,
          onResize: () => () => undefined,
        },
      });
      return { log, written, detach };
    };

    it('shows the panel and leaves the periodic lines out, since the panel already says it', () => {
      const { log, written } = withPanel({ rows: 24, cols: 80 });
      expect(written.join('')).toContain('profiling');
      log.mockClear();
      vi.advanceTimersByTime(30_000);
      expect(log).not.toHaveBeenCalled();
    });

    it('falls back to the periodic lines when the terminal is too small', () => {
      const { log, written } = withPanel({ rows: 6, cols: 80 });
      expect(written).toEqual([]);
      vi.advanceTimersByTime(5_000);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/still profiling/));
    });

    it('gives the screen back when detached', () => {
      const { written, detach } = withPanel({ rows: 24, cols: 80 });
      detach();
      expect(written.join('')).toContain('[r');
    });
  });
});
