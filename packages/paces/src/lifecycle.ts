export interface Activity {
  lastRequestAt(): number;
  lastHeartbeatAt(): number | undefined;
}

export interface CloseOptions {
  /** Silence needed after the window is gone before the CLI exits; a reload fits inside it. */
  graceMs: number;
  /** Resolves when the browser process we launched has exited. */
  browserExited?: Promise<void>;
  pollMs?: number;
  now?: () => number;
  signal?: AbortSignal;
}

/**
 * Resolves `closed` when the window is gone: either the browser process exited, or the UI had been
 * sending heartbeats and stopped, and in both cases nothing has been requested for `graceMs`.
 * A UI that never sends a heartbeat in a browser we cannot watch keeps the CLI alive until Ctrl+C.
 */
export function waitForWindowClose(
  host: Activity,
  options: CloseOptions,
): Promise<'closed' | 'aborted'> {
  const now = options.now ?? Date.now;
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
      const gone = browserGoneAt !== undefined || host.lastHeartbeatAt() !== undefined;
      if (quiet && gone) finish('closed');
    }, poll);
    options.signal?.addEventListener('abort', () => finish('aborted'), { once: true });
  });
}
