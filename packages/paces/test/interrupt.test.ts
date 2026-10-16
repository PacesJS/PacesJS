import { describe, expect, it } from 'vitest';
import { createInterruptHandler } from '../src/interrupt.js';

function setup(over: { flushed?: boolean; exitsAfter?: number } = {}) {
  const calls: string[] = [];
  let exit!: () => void;
  const childExited = new Promise<void>((r) => (exit = r));
  let flush!: () => void;
  const allFlushed = new Promise<void>((r) => (flush = r));
  if (over.flushed) flush();
  if (over.exitsAfter !== undefined) setTimeout(exit, over.exitsAfter);
  const handler = createInterruptHandler({
    sendStop: () => calls.push('stop'),
    sendSigint: () => calls.push('sigint'),
    kill: () => calls.push('kill'),
    allFlushed,
    childExited,
    flushTimeoutMs: 80,
    exitGraceMs: 40,
  });
  return { calls, handler, exit, flush };
}

describe('interrupt handler (R11)', () => {
  it('sends stop first, and emulates Ctrl+C when the target does not leave on its own', async () => {
    const { calls, handler } = setup({ flushed: true });
    await handler();
    expect(calls).toEqual(['stop', 'sigint']);
  });

  it('does not emulate Ctrl+C when the target exits during the grace period', async () => {
    const { calls, handler } = setup({ flushed: true, exitsAfter: 10 });
    await handler();
    expect(calls).toEqual(['stop']);
  });

  it('stops waiting for flush acks after the timeout and still proceeds', async () => {
    const { calls, handler } = setup();
    const started = Date.now();
    await handler();
    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
    expect(calls).toEqual(['stop', 'sigint']);
  });

  it('proceeds at once when the target exits before acking (a terminal Ctrl+C reached it too)', async () => {
    const { calls, handler } = setup({ exitsAfter: 5 });
    const started = Date.now();
    await handler();
    expect(Date.now() - started).toBeLessThan(70);
    expect(calls).toEqual(['stop']);
  });

  it('kills immediately on the second interrupt', async () => {
    const { calls, handler } = setup();
    const first = handler();
    await handler();
    expect(calls).toEqual(['stop', 'kill']);
    await first;
  });
});
