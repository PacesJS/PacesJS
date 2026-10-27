import type { CdpEvent, CdpLike } from './cdp-pipe.js';
import { createScreenshotStore } from './screenshot-store.js';
import type { ScreenshotResult } from './screenshot-store.js';
import type { TraceEvent, TraceFilterStats } from './trace.js';
import { EXCLUDED_CATEGORIES, createTraceFilter } from './trace-filter.js';

/** Events older than the start marker by more than this are strays, not part of the segment. */
const STRAY_US = 1_000_000;

export type Phase = 'ready' | 'recording' | 'pausing' | 'paused' | 'stopping' | 'done';

export interface ControllerOptions {
  screenshots: boolean;
  startPaused: boolean;
  fullTrace: boolean;
  keepQuery: boolean;
  /** Ask V8 for a 100 µs sampling interval instead of the default. */
  hiRes: boolean;
  /** How long to wait for the browser to hand over a segment's events. */
  flushTimeoutMs?: number;
}

export interface ControllerState {
  phase: Phase;
  elapsedMs: number;
  marks: number;
  segments: number;
  /** Set while a segment is being collected: events read so far and, when known, the total. */
  collecting?: { read: number; total: number };
}

export interface Segment {
  startUs: number;
  endUs: number;
  /** Host epoch ms right after tracing started: the fallback clock anchor. */
  hostStartMs: number;
  /** Epoch ms the page reported for each `paces:sync:<n>` TimeStamp. */
  syncs: Array<{ n: number; epochMs: number }>;
}

/** A moment recorded while the program ran. `at` is epoch milliseconds. */
export interface RecordedMark {
  at: number;
  label: string;
  kind: string;
  /** Joins an automatic event to its `TimeStamp` in the trace. */
  seq?: string;
  frame?: string;
}

export interface Recording {
  events: TraceEvent[];
  segments: Segment[];
  marks: RecordedMark[];
  screenshots: ScreenshotResult;
  filter: TraceFilterStats;
}

export interface ControllerDeps {
  cdp: CdpLike;
  options: ControllerOptions;
  /** Asks the page to emit `paces:sync:<n>`; returns its epoch ms. */
  syncClock: (n: number) => Promise<number | undefined>;
  /** Ids of the frames being recorded, so the trace can be cut down to their processes. */
  ownFrames?: () => ReadonlySet<string>;
  now?: () => number;
  onChange?: (state: ControllerState) => void;
}

export interface SessionController {
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<Recording>;
  mark(label: string, kind?: string, extra?: { at?: number; seq?: string; frame?: string }): void;
  /** A frame of the page, taken at `epochMs`. Kept only while recording, and only if screenshots are on. */
  addScreenshot(epochMs: number, bytes: Uint8Array): void;
  state(): ControllerState;
  /** What has been collected so far, without ending anything: for a browser that went away. */
  partial(): Recording;
}

const BASE_CATEGORIES = [
  'devtools.timeline',
  'loading',
  'v8.execute',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack',
  'blink.user_timing',
  'blink.console',
  'latencyInfo',
  'disabled-by-default-v8.cpu_profiler',
];
const HI_RES_CATEGORY = 'disabled-by-default-v8.cpu_profiler.hires';
const SCREENSHOT_CAP = 600;
const SCREENSHOT_MAX_BYTES = 64 * 1024 * 1024;

export function createSessionController(deps: ControllerDeps): SessionController {
  const { cdp, options } = deps;
  const now = deps.now ?? Date.now;
  const flushTimeoutMs = options.flushTimeoutMs ?? 120_000;
  const filter = createTraceFilter({
    keepQuery: options.keepQuery,
    full: options.fullTrace,
    ...(deps.ownFrames ? { ownFrames: deps.ownFrames } : {}),
  });
  const shots = createScreenshotStore({ cap: SCREENSHOT_CAP, maxBytes: SCREENSHOT_MAX_BYTES });
  const events: TraceEvent[] = [];
  const segments: Segment[] = [];
  const marks: RecordedMark[] = [];

  let phase: Phase = 'ready';
  let started = false;
  let collecting: { read: number; total: number } | undefined;
  let segment: Segment | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let manualMarks = 0;
  const beganAt = now();

  const state = (): ControllerState => ({
    phase,
    elapsedMs: now() - beganAt,
    marks: marks.filter((m) => m.kind === 'manual').length,
    segments: segments.length,
    ...(collecting ? { collecting: { ...collecting } } : {}),
  });
  const notify = (): void => deps.onChange?.(state());
  const setPhase = (next: Phase): void => {
    phase = next;
    notify();
  };
  // One operation at a time keeps a double click on Pause from ending tracing twice.
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  let flush: { resolve: () => void; bounds: { start: number; end: number } } | undefined;
  cdp.onEvent((e: CdpEvent) => {
    // Tracing is on the browser, so its events carry no session; a page's own events are not ours.
    if (e.sessionId) return;
    if (e.method === 'Tracing.bufferUsage' && collecting) {
      const total = (e.params as { eventCount?: number } | undefined)?.eventCount;
      if (typeof total === 'number') collecting.total = total;
      notify();
    } else if (e.method === 'Tracing.dataCollected' && flush) {
      const batch = (e.params as { value?: TraceEvent[] } | undefined)?.value ?? [];
      for (const ev of filter.push(batch)) {
        events.push(ev);
        if (ev.ph !== 'M') {
          flush.bounds.start = Math.min(flush.bounds.start, ev.ts);
          flush.bounds.end = Math.max(flush.bounds.end, ev.ts + (ev.dur ?? 0));
        }
      }
      if (collecting) collecting.read += batch.length;
      notify();
    } else if (e.method === 'Tracing.tracingComplete') {
      flush?.resolve();
    }
  });

  async function beginSegment(): Promise<void> {
    const included = [...BASE_CATEGORIES];
    if (options.hiRes) included.push(HI_RES_CATEGORY);
    // On the browser, not on a page: the trace has to outlive the page when the user closes it.
    await cdp.send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: {
        recordMode: 'recordAsMuchAsPossible',
        includedCategories: included,
        excludedCategories: options.fullTrace ? [] : EXCLUDED_CATEGORIES,
      },
    });
    const next: Segment = {
      startUs: Number.POSITIVE_INFINITY,
      endUs: Number.NEGATIVE_INFINITY,
      hostStartMs: now(),
      syncs: [],
    };
    segment = next;
    setPhase('recording');
    const n = segments.length + 1;
    try {
      const epochMs = await deps.syncClock(n);
      if (epochMs !== undefined) next.syncs.push({ n, epochMs });
    } catch {
      // Without the page script the converter falls back to the host's clock.
    }
  }

  /**
   * A browser sometimes hands over a few events stamped long before tracing started (frames of
   * another process, left over from earlier). They would stretch the segment over time that was
   * never recorded, so anything much older than the start marker is dropped.
   */
  function dropStrays(from: number, bounds: { start: number; end: number }): void {
    let started = Number.POSITIVE_INFINITY;
    for (let k = from; k < events.length; k++) {
      const e = events[k];
      if (e && e.name === 'TracingStartedInBrowser') started = Math.min(started, e.ts);
    }
    if (!Number.isFinite(started)) return;
    const kept = events.slice(from).filter((e) => e.ph === 'M' || e.ts >= started - STRAY_US);
    if (kept.length === events.length - from) return;
    events.length = from;
    bounds.start = Number.POSITIVE_INFINITY;
    bounds.end = Number.NEGATIVE_INFINITY;
    for (const e of kept) {
      events.push(e);
      if (e.ph === 'M') continue;
      bounds.start = Math.min(bounds.start, e.ts);
      bounds.end = Math.max(bounds.end, e.ts + (e.dur ?? 0));
    }
  }

  async function endSegment(): Promise<void> {
    const current = segment;
    if (!current) return;
    collecting = { read: 0, total: 0 };
    const firstOfSegment = events.length;
    const bounds = { start: Number.POSITIVE_INFINITY, end: Number.NEGATIVE_INFINITY };
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `The browser did not hand over its trace within ${Math.round(flushTimeoutMs / 1000)} s. Try a shorter run, or --no-screenshots.`,
            ),
          ),
        flushTimeoutMs,
      );
      flush = {
        bounds,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
    });
    try {
      await cdp.send('Tracing.end');
      await done;
    } finally {
      flush = undefined;
      collecting = undefined;
    }
    dropStrays(firstOfSegment, bounds);
    current.startUs = Number.isFinite(bounds.start) ? bounds.start : 0;
    current.endUs = Number.isFinite(bounds.end) ? bounds.end : current.startUs;
    segments.push(current);
    segment = undefined;
  }

  return {
    state,
    start: () =>
      serial(async () => {
        if (started) return;
        started = true;
        if (options.startPaused) {
          setPhase('ready');
          return;
        }
        await beginSegment();
      }),
    pause: () =>
      serial(async () => {
        if (phase !== 'recording') return;
        setPhase('pausing');
        await endSegment();
        setPhase('paused');
      }),
    resume: () =>
      serial(async () => {
        if (phase !== 'paused' && phase !== 'ready') return;
        await beginSegment();
      }),
    stop: () =>
      serial(async () => {
        if (phase === 'done') return finish();
        const wasRecording = phase === 'recording';
        setPhase('stopping');
        if (wasRecording) await endSegment();
        setPhase('done');
        return finish();
      }),
    partial: () => finish(),
    addScreenshot(epochMs, bytes) {
      if (phase === 'recording' && options.screenshots) shots.add(epochMs, bytes);
    },
    mark(label, kind = 'manual', extra = {}) {
      const trimmed = label.trim();
      if (kind === 'manual') manualMarks++;
      marks.push({
        at: extra.at ?? now(),
        label: trimmed || `Mark ${manualMarks}`,
        kind,
        ...(extra.seq !== undefined ? { seq: extra.seq } : {}),
        ...(extra.frame !== undefined ? { frame: extra.frame } : {}),
      });
      notify();
    },
  };

  function finish(): Recording {
    return {
      events,
      segments,
      marks: [...marks].sort((a, b) => a.at - b.at),
      screenshots: shots.finish(),
      filter: filter.stats(),
    };
  }
}
