import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ProfileControls } from '../src/profile.js';
import { terminalOptions } from '../src/terminal.js';

class FakeStderr extends EventEmitter {
  isTTY = true;
  rows = 30;
  columns = 100;
  written: string[] = [];
  write(s: string): boolean {
    this.written.push(s);
    return true;
  }
}

const controls = {} as ProfileControls;

const build = (over: { noPanel?: boolean; tty?: boolean; env?: Record<string, string> } = {}) => {
  const stderr = new FakeStderr();
  stderr.isTTY = over.tty ?? true;
  const logged: string[] = [];
  const options = terminalOptions({
    controls,
    flag: undefined,
    noPanel: over.noPanel ?? false,
    isTTY: true,
    input: new EventEmitter() as never,
    stderr,
    env: over.env ?? {},
    log: (l) => logged.push(l),
  });
  return { options, stderr, logged };
};

describe('the terminal options of a run', () => {
  it('passes the controls, the keys flag and the input through', () => {
    const { options } = build();
    expect(options.controls).toBe(controls);
    expect(options.flag).toBeUndefined();
    expect(options.isTTY).toBe(true);
  });

  it('draws the status panel on stderr when it is a terminal', () => {
    const { options, stderr } = build();
    options.panel?.write('x');
    expect(stderr.written).toEqual(['x']);
    expect(options.panel?.size()).toEqual({ rows: 30, cols: 100 });
  });

  it('has no panel when stderr is not a terminal or --no-panel is set', () => {
    expect(build({ tty: false }).options.panel).toBeUndefined();
    expect(build({ noPanel: true }).options.panel).toBeUndefined();
  });

  it('colors the panel unless NO_COLOR is set', () => {
    expect(build().options.panel?.color).toBe(true);
    expect(build({ env: { NO_COLOR: '1' } }).options.panel?.color).toBe(false);
  });

  it('listens for resizes and can stop listening', () => {
    const { options, stderr } = build();
    let n = 0;
    const off = options.panel?.onResize(() => n++);
    stderr.emit('resize');
    off?.();
    stderr.emit('resize');
    expect(n).toBe(1);
  });

  it('writes the terminal title only on a terminal', () => {
    const on = build();
    on.options.title('t');
    expect(on.stderr.written).toEqual(['t']);
    const off = build({ tty: false });
    off.options.title('t');
    expect(off.stderr.written).toEqual([]);
  });

  it('logs to the given function', () => {
    const { options, logged } = build();
    options.log('hello');
    expect(logged).toEqual(['hello']);
  });
});
