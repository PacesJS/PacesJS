import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_ROWS, panelLines, panelSupported, startPanel } from '../src/panel.js';

const state = { processes: 2, marks: 1, keys: true };

describe('panelSupported', () => {
  it.each([
    [{ rows: 24, cols: 80 }, true],
    [{ rows: 8, cols: 80 }, false],
    [{ rows: 24, cols: 30 }, false],
    [{ rows: undefined, cols: 80 }, false],
  ])('%j is %s', (size, ok) => {
    expect(panelSupported(size)).toBe(ok);
  });
});

describe('panelLines', () => {
  it('has a rule, a status line and a key line', () => {
    const lines = panelLines(65_000, 0, state, 80);
    expect(lines).toHaveLength(PANEL_ROWS);
    expect(lines[0]).toBe('─'.repeat(80));
    expect(lines[1]).toContain('profiling');
    expect(lines[1]).toContain('1:05');
    expect(lines[1]).toContain('2 processes');
    expect(lines[1]).toContain('1 mark');
    expect(lines[2]).toContain('m add a mark');
    expect(lines[2]).toContain('s stop and show results');
  });

  it('leaves out the process count until a process has reported in, and the marks until there are some', () => {
    const lines = panelLines(1_000, 0, { processes: 0, marks: 0, keys: false }, 80);
    expect(lines[1]).not.toContain('process');
    expect(lines[1]).not.toContain('mark');
  });

  it('always names the way out for a program that needs the keyboard', () => {
    expect(panelLines(1_000, 0, state, 80)[2]).toContain('--no-keys');
  });

  it('warns, and says how to fix it, once a process has read stdin while paces holds the keyboard', () => {
    const lines = panelLines(1_000, 0, { ...state, stdinUsed: true }, 80);
    expect(lines[1]).toContain('reads stdin');
    expect(lines[1]).toContain('--no-keys');
  });

  it('keeps the shortcuts on screen when it warns about stdin', () => {
    const lines = panelLines(1_000, 0, { ...state, stdinUsed: true }, 80);
    expect(lines[2]).toContain('m add a mark');
    expect(lines[2]).toContain('s stop and show results');
  });

  it('does not warn when the hotkeys are off, since paces is not holding the keyboard', () => {
    const lines = panelLines(1_000, 0, { ...state, keys: false, stdinUsed: true }, 80);
    expect(lines.join('')).not.toContain('reads stdin');
  });

  it('shows only Ctrl+C when the hotkeys are off', () => {
    const lines = panelLines(1_000, 0, { ...state, keys: false }, 80);
    expect(lines[2]).toContain('Ctrl+C stops and shows the results');
    expect(lines[2]).not.toContain('add a mark');
  });

  it('says what to press to place a mark', () => {
    expect(panelLines(1_000, 0, state, 100)[2]).toContain('m add a mark');
  });

  it('moves the spinner each tick', () => {
    const a = panelLines(0, 0, state, 80)[1];
    const b = panelLines(0, 1, state, 80)[1];
    expect(a).not.toBe(b);
  });

  it('never runs past the width of the terminal', () => {
    for (const line of panelLines(65_000, 3, state, 40)) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });
});

describe('startPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const ESC = '\u001b';
  const setup = (size = { rows: 24, cols: 80 }) => setupWith(state, {}, size);
  const setupWith = (
    live: typeof state & { stdinUsed?: boolean },
    over: { color?: boolean } = {},
    size = { rows: 24, cols: 80 },
  ) => {
    const out: string[] = [];
    const resizeListeners: Array<() => void> = [];
    const current = { ...size };
    const stop = startPanel({
      write: (s) => out.push(s),
      size: () => current,
      onResize: (l) => {
        resizeListeners.push(l);
        return () => resizeListeners.splice(resizeListeners.indexOf(l), 1);
      },
      state: () => live,
      now: () => Date.now(),
      ...over,
    });
    return {
      out,
      stop,
      all: () => out.join(''),
      resize: (rows: number, cols: number) => {
        current.rows = rows;
        current.cols = cols;
        for (const l of [...resizeListeners]) l();
      },
      listeners: resizeListeners,
    };
  };

  it('keeps the program above the panel by scrolling only the rows over it', () => {
    const { all } = setup();
    expect(all()).toContain(`${ESC}[1;21r`);
    expect(all()).toContain(`${ESC}[21;1H`);
  });

  it('draws the panel in the reserved rows without moving the cursor', () => {
    const { all } = setup();
    expect(all()).toContain(`${ESC}7`);
    expect(all()).toContain(`${ESC}[22;1H`);
    expect(all()).toContain(`${ESC}[24;1H`);
    expect(all()).toContain(`${ESC}8`);
    expect(all()).toContain('profiling');
  });

  it('redraws on a timer so the spinner and clock move', () => {
    const { out } = setup();
    const before = out.length;
    vi.advanceTimersByTime(1_200);
    expect(out.length).toBeGreaterThan(before + 3);
    expect(out.join('')).toContain('0:01');
  });

  it('gives the screen back on stop: cursor left where the program had it, region reset, panel cleared', () => {
    const { out, stop } = setup();
    stop();
    const all = out.join('');
    const restore = `${ESC}7${ESC}[r${ESC}8${ESC}[J`;
    expect(all.slice(all.lastIndexOf(`${ESC}7${ESC}[r`))).toBe(restore);
    const length = out.length;
    vi.advanceTimersByTime(5_000);
    expect(out.length).toBe(length);
  });

  it('picks the key names out in color, and the stdin warning in a warning color', () => {
    const calm = setup().all();
    expect(calm).toContain(`${ESC}[1;36mm${ESC}[0m add a mark`);
    const warned = setupWith({ ...state, stdinUsed: true }).all();
    expect(warned).toContain(`${ESC}[1;33m! reads stdin`);
  });

  it('uses no color at all when color is off', () => {
    const plain = setupWith(state, { color: false }).all();
    expect(plain).not.toContain(`${ESC}[1;36m`);
    expect(plain).not.toContain(`${ESC}[1;33m`);
    expect(plain).not.toContain(`${ESC}[2m`);
    expect(plain).toContain('m add a mark');
  });

  it('stopping twice restores the screen once', () => {
    const { out, stop } = setup();
    stop();
    const length = out.length;
    stop();
    expect(out.length).toBe(length);
  });

  it('lays out again when the terminal is resized', () => {
    const { all, resize } = setup();
    resize(40, 100);
    expect(all()).toContain(`${ESC}[1;37r`);
    expect(all()).toContain(`${ESC}[38;1H`);
  });

  it('stops listening for resizes once stopped', () => {
    const { listeners, stop } = setup();
    expect(listeners).toHaveLength(1);
    stop();
    expect(listeners).toHaveLength(0);
  });
});
