/** Five minutes: beyond browsers' intensive timer throttling (once a minute) with margin. */
const DEFAULT_STALE_HEARTBEAT_MS = 5 * 60_000;

export interface Activity {
  lastRequestAt(): number;
  lastHeartbeatAt(): number | undefined;
  /** Epoch ms of the last explicit "the page is going away" signal, if any. */
  lastGoodbyeAt?(): number | undefined;
}

export interface CloseOptions {
  /** Silence needed after the window is gone before the CLI exits; a reload fits inside it. */
  graceMs: number;
  /**
   * Heartbeat silence that alone means the window is gone. Long on purpose: minimized or hidden
   * windows have their timers throttled (to once a minute after a few minutes), so a short gap
   * says nothing. Explicit goodbyes and the browser process exiting are the fast signals.
   */
  staleHeartbeatMs?: number;
  /** Resolves when the browser process we launched has exited. */
  browserExited?: Promise<void>;
  pollMs?: number;
  now?: () => number;
  signal?: AbortSignal;
}

/**
 * Resolves `closed` when the window is gone: the browser process exited, or the page said goodbye
 * (and did not come back), or heartbeats stopped for `staleHeartbeatMs`; in every case nothing has
 * been requested for `graceMs`. A UI that never sends a heartbeat in a browser we cannot watch keeps
 * the CLI alive until Ctrl+C.
 */
export function waitForWindowClose(
  host: Activity,
  options: CloseOptions,
): Promise<'closed' | 'aborted'> {
  const now = options.now ?? Date.now;
  const staleHeartbeatMs = options.staleHeartbeatMs ?? DEFAULT_STALE_HEARTBEAT_MS;
  const poll = options.pollMs ?? Math.max(10, Math.min(500, options.graceMs / 4));
  let browserGoneAt: number | undefined;
  void options.browserExited?.then(() => {
    browserGoneAt = now();
  });
  return new Promise((resolve) => {
    const finish = (r: 'closed' | 'aborted'): void => {
      clearInterval(timer);
      resolve(r);
    };
    const timer = setInterval(() => {
      const last = Math.max(host.lastRequestAt(), browserGoneAt ?? 0);
      const quiet = now() - last >= options.graceMs;
      const beat = host.lastHeartbeatAt();
      const goodbye = host.lastGoodbyeAt?.();
      // A goodbye only counts until the page is heard from again (a reload says goodbye too).
      const saidGoodbye = goodbye !== undefined && goodbye >= (beat ?? 0);
      const heartbeatsStale = beat !== undefined && now() - beat >= staleHeartbeatMs;
      const gone = browserGoneAt !== undefined || saidGoodbye || heartbeatsStale;
      if (quiet && gone) finish('closed');
    }, poll);
    options.signal?.addEventListener('abort', () => finish('aborted'), { once: true });
  });
}
