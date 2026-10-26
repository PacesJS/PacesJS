import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { keyActions, keysEnabled, startKeys } from '../src/keys.js';
import type { KeyInput } from '../src/keys.js';

describe('keyActions', () => {
  it.each([
    ['m', ['mark']],
    ['M', ['mark']],
    ['s', ['stop']],
    ['S', ['stop']],
    ['p', ['pause']],
    ['P', ['pause']],
    ['\u0003', ['interrupt']],
    ['x', []],
    ['\r', []],
    ['\u001b[A', []],
    ['ms', ['mark', 'stop']],
  ])('reads %j as %j', (chunk, actions) => {
    expect(keyActions(chunk)).toEqual(actions);
  });
});

describe('keysEnabled', () => {
  it.each([
    [{ flag: undefined, isTTY: true }, true],
    [{ flag: true, isTTY: true }, true],
    [{ flag: false, isTTY: true }, false],
    [{ flag: true, isTTY: false }, false],
    [{ flag: undefined, isTTY: false }, false],
  ])('%j -> %s', (input, expected) => {
    expect(keysEnabled(input)).toBe(expected);
  });
});

class FakeInput extends EventEmitter implements KeyInput {
  isTTY = true;
  raw: boolean[] = [];
  paused = true;
  setRawMode(on: boolean): this {
    this.raw.push(on);
    return this;
  }
  resume(): this {
    this.paused = false;
    return this;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
}

describe('startKeys', () => {
  it('reads single keys without Enter and hands each action to its handler', () => {
    const input = new FakeInput();
    const handlers = { mark: vi.fn(), stop: vi.fn(), pause: vi.fn(), interrupt: vi.fn() };
    startKeys(input, handlers);
    expect(input.raw).toEqual([true]);
    expect(input.paused).toBe(false);
    input.emit('data', Buffer.from('m'));
    input.emit('data', Buffer.from('s'));
    input.emit('data', Buffer.from('\u0003'));
    expect(handlers.mark).toHaveBeenCalledTimes(1);
    expect(handlers.stop).toHaveBeenCalledTimes(1);
    expect(handlers.interrupt).toHaveBeenCalledTimes(1);
  });

  it('gives the terminal back when stopped, and ignores keys after that', () => {
    const input = new FakeInput();
    const handlers = { mark: vi.fn(), stop: vi.fn(), pause: vi.fn(), interrupt: vi.fn() };
    const stop = startKeys(input, handlers);
    stop();
    expect(input.raw).toEqual([true, false]);
    expect(input.paused).toBe(true);
    input.emit('data', Buffer.from('m'));
    expect(handlers.mark).not.toHaveBeenCalled();
    stop();
    expect(input.raw).toEqual([true, false]);
  });

  it('does nothing on input that is not a terminal', () => {
    const input = new FakeInput();
    input.isTTY = false;
    const stop = startKeys(input, {
      mark: vi.fn(),
      stop: vi.fn(),
      pause: vi.fn(),
      interrupt: vi.fn(),
    });
    expect(input.raw).toEqual([]);
    expect(input.paused).toBe(true);
    expect(() => stop()).not.toThrow();
  });
});
