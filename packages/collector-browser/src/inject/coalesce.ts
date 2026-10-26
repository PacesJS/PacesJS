// Runs inside the page; self-contained (see labels.ts).

export interface CoalescerDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  emit(kind: string, label: string): void;
  maxPerSecond?: number;
  maxTotal?: number;
}

export interface Coalescer {
  /** One keystroke in a field; bursts become a single event once typing stops for 500 ms. */
  typing(field: string): void;
  /** A scroll; only the first after a second of quiet is reported. */
  scroll(): void;
  event(kind: string, label: string): void;
  /** Emits whatever is pending, plus the `…N more` entry for dropped events. */
  flush(): void;
}

/** Turns raw page events into a bounded stream: bursts merged, rate and total limited. */
export function createCoalescer(deps: CoalescerDeps): Coalescer {
  const maxPerSecond = deps.maxPerSecond ?? 20;
  const maxTotal = deps.maxTotal ?? 5000;
  let windowStart = Number.NEGATIVE_INFINITY;
  let windowCount = 0;
  let total = 0;
  let dropped = 0;
  let lastScroll = Number.NEGATIVE_INFINITY;
  let burst:
    { field: string; count: number; start: number; last: number; timer: unknown } | undefined;

  const reportDropped = (): void => {
    if (dropped === 0) return;
    const n = dropped;
    dropped = 0;
    deps.emit('more', '…' + n + ' more');
  };

  const send = (kind: string, label: string): void => {
    const t = deps.now();
    if (t - windowStart >= 1000) {
      reportDropped();
      windowStart = t;
      windowCount = 0;
    }
    if (total >= maxTotal || windowCount >= maxPerSecond) {
      dropped++;
      return;
    }
    windowCount++;
    total++;
    deps.emit(kind, label);
  };

  const endBurst = (): void => {
    if (!burst) return;
    const done = burst;
    burst = undefined;
    deps.clearTimer(done.timer);
    const seconds = Math.round(((done.last - done.start) / 1000) * 10) / 10;
    send(
      'typing',
      done.field + ' (' + done.count + (done.count === 1 ? ' key, ' : ' keys, ') + seconds + ' s)',
    );
  };

  return {
    typing(field) {
      if (burst && burst.field !== field) endBurst();
      const t = deps.now();
      if (!burst) burst = { field, count: 0, start: t, last: t, timer: undefined };
      else deps.clearTimer(burst.timer);
      burst.count++;
      burst.last = t;
      burst.timer = deps.setTimer(endBurst, 500);
    },
    scroll() {
      const t = deps.now();
      const quiet = t - lastScroll >= 1000;
      lastScroll = t;
      if (quiet) send('scroll', 'scroll');
    },
    event: send,
    flush() {
      endBurst();
      reportDropped();
    },
  };
}
