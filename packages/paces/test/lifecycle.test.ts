import { describe, expect, it } from 'vitest';
import { waitForWindowClose } from '../src/lifecycle.js';

function activity(initial: { request: number; heartbeat?: number }) {
  const state = { ...initial };
  return {
    state,
    lastRequestAt: () => state.request,
    lastHeartbeatAt: () => state.heartbeat,
  };
}

describe('waitForWindowClose', () => {
  it('closes after the browser exits and the grace period passes quietly', async () => {
    const a = activity({ request: Date.now() });
    const started = Date.now();
    const result = await waitForWindowClose(a, {
      graceMs: 60,
      browserExited: Promise.resolve(),
      pollMs: 10,
    });
    expect(result).toBe('closed');
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  it('stays open when requests keep arriving within the grace period (a reload)', async () => {
    const a = activity({ request: Date.now() });
    const keepAlive = setInterval(() => (a.state.request = Date.now()), 15);
    const outcome = await Promise.race([
      waitForWindowClose(a, { graceMs: 80, browserExited: Promise.resolve(), pollMs: 10 }),
      new Promise<string>((r) => setTimeout(() => r('still open'), 300)),
    ]);
    clearInterval(keepAlive);
    expect(outcome).toBe('still open');
  });

  it('closes when heartbeats were seen and then stopped, without a browser handle', async () => {
    const t = Date.now();
    const a = activity({ request: t, heartbeat: t });
    expect(await waitForWindowClose(a, { graceMs: 50, pollMs: 10 })).toBe('closed');
  });

  it('never closes by itself when no heartbeat was ever seen and the browser is unwatched', async () => {
    const a = activity({ request: Date.now() - 10_000 });
    const outcome = await Promise.race([
      waitForWindowClose(a, { graceMs: 20, pollMs: 5 }),
      new Promise<string>((r) => setTimeout(() => r('still open'), 150)),
    ]);
    expect(outcome).toBe('still open');
  });

  it('can be aborted', async () => {
    const ac = new AbortController();
    const p = waitForWindowClose(activity({ request: Date.now() }), {
      graceMs: 1000,
      signal: ac.signal,
    });
    ac.abort();
    expect(await p).toBe('aborted');
  });
});
