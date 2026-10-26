import type { CdpEvent, CdpLike } from './cdp-pipe.js';
import { createScreenshotStore } from './screenshot-store.js';
import type { ScreenshotResult } from './screenshot-store.js';
import type { TraceEvent, TraceFilterStats } from './trace.js';
import { EXCLUDED_CATEGORIES, createTraceFilter } from './trace-filter.js';

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
  /** Session of the first page: tracing must start there for screenshots to be recorded. */
  session: string;
  options: ControllerOptions;
  /** Asks the page to emit `paces:sync:<n>`; returns its epoch ms. */
  syncClock: (n: number) => Promise<number | undefined>;
  now?: () => number;
  onChange?: (state: ControllerState) => void;
}

export interface SessionController {
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<Recording>;
  mark(label: string, kind?: string, extra?: { at?: number; seq?: string; frame?: string }): void;
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
  'blink.user_timing',
  'blink.console',
  'latencyInfo',
  'disabled-by-default-v8.cpu_profiler',
];
const SCREENSHOT_CATEGORY = 'disabled-by-default-devtools.screenshot';
const HI_RES_CATEGORY = 'disabled-by-default-v8.cpu_profiler.hires';
const SCREENSHOT_CAP = 600;
const SCREENSHOT_MAX_BYTES = 64 * 1024 * 1024;

export function createSessionController(deps: ControllerDeps): SessionController {
  const { cdp, session, options } = deps;
  const now = deps.now ?? Date.now;
  const flushTimeoutMs = options.flushTimeoutMs ?? 120_000;
  const filter = createTraceFilter({ keepQuery: options.keepQuery, full: options.fullTrace });
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
    if (e.sessionId !== session) return;
    if (e.method === 'Tracing.bufferUsage' && collecting) {
      const total = (e.params as { eventCount?: number } | undefined)?.eventCount;
      if (typeof total === 'number') collecting.total = total;
      notify();
    } else if (e.method === 'Tracing.dataCollected' && flush) {
      const batch = (e.params as { value?: TraceEvent[] } | undefined)?.value ?? [];
      const plain: TraceEvent[] = [];
      for (const ev of batch) {
        if (ev.name === 'Screenshot') {
          const snapshot = (ev.args as { snapshot?: unknown } | undefined)?.snapshot;
          if (options.screenshots && typeof snapshot === 'string') {
            shots.add(ev.ts, Uint8Array.from(Buffer.from(snapshot, 'base64')));
          }
        } else plain.push(ev);
      }
      for (const ev of filter.push(plain)) {
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
    if (options.screenshots) included.push(SCREENSHOT_CATEGORY);
    if (options.hiRes) included.push(HI_RES_CATEGORY);
    await cdp.send(
      'Tracing.start',
      {
        transferMode: 'ReportEvents',
        traceConfig: {
          recordMode: 'recordAsMuchAsPossible',
          includedCategories: included,
          excludedCategories: options.fullTrace ? [] : EXCLUDED_CATEGORIES,
        },
      },
      session,
    );
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

  async function endSegment(): Promise<void> {
    const current = segment;
    if (!current) return;
    collecting = { read: 0, total: 0 };
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
      await cdp.send('Tracing.end', {}, session);
      await done;
    } finally {
      flush = undefined;
      collecting = undefined;
    }
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
