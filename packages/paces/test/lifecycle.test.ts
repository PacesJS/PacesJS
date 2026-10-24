import { describe, expect, it } from 'vitest';
import { DEFAULT_GRACE_MS, waitForWindowClose } from '../src/lifecycle.js';

function activity(initial: { request: number; heartbeat?: number; goodbye?: number }) {
  const state = { ...initial };
  return {
    state,
    lastRequestAt: () => state.request,
    lastHeartbeatAt: () => state.heartbeat,
    lastGoodbyeAt: () => state.goodbye,
  };
}

describe('DEFAULT_GRACE_MS', () => {
  it('outlasts the page heartbeat (2 s) so a live window never looks gone, yet exits promptly', () => {
    expect(DEFAULT_GRACE_MS).toBeGreaterThan(2000);
    expect(DEFAULT_GRACE_MS).toBeLessThanOrEqual(3000);
  });
});

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

  it('does not mistake a throttled background window for a closed one', async () => {
    // Minimized or hidden windows have their timers throttled (to once a minute after a while), so
    // a gap in heartbeats is not proof that the window is gone.
    const t = Date.now();
    const a = activity({ request: t - 5000, heartbeat: t - 5000 });
    const outcome = await Promise.race([
      waitForWindowClose(a, { graceMs: 30, staleHeartbeatMs: 60_000, pollMs: 5 }),
      new Promise<string>((r) => setTimeout(() => r('still open'), 150)),
    ]);
    expect(outcome).toBe('still open');
  });

  it('closes when heartbeats stopped for longer than the stale threshold, with no other signal', async () => {
    const t = Date.now();
    const a = activity({ request: t - 1000, heartbeat: t - 1000 });
    expect(await waitForWindowClose(a, { graceMs: 30, staleHeartbeatMs: 80, pollMs: 5 })).toBe(
      'closed',
    );
  });

  it('closes after an explicit goodbye once the grace period passes quietly', async () => {
    const t = Date.now();
    const a = activity({ request: t, heartbeat: t - 10, goodbye: t });
    expect(await waitForWindowClose(a, { graceMs: 50, staleHeartbeatMs: 60_000, pollMs: 10 })).toBe(
      'closed',
    );
  });

  it('survives a reload: a goodbye followed by a new heartbeat does not close', async () => {
    const t = Date.now();
    const a = activity({ request: t, heartbeat: t, goodbye: t - 20 });
    const keepAlive = setInterval(() => {
      a.state.request = Date.now();
      a.state.heartbeat = Date.now();
    }, 10);
    const outcome = await Promise.race([
      waitForWindowClose(a, { graceMs: 60, staleHeartbeatMs: 60_000, pollMs: 10 }),
      new Promise<string>((r) => setTimeout(() => r('still open'), 250)),
    ]);
    clearInterval(keepAlive);
    expect(outcome).toBe('still open');
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
