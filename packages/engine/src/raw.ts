// Raw capture types: what collectors produce and the engine ingests.
// Collectors speak the Chrome DevTools Protocol, so Node and browsers share these shapes.

export type TrackId = string;

export type TrackKind = 'process' | 'worker' | 'page' | 'frame' | 'extension';

export interface TrackInfo {
  id: TrackId;
  kind: TrackKind;
  label: string;
  pid?: number;
  threadId?: number;
  /** Track that spawned this one (worker -> its process, child process -> parent process). */
  parent?: TrackId;
  /** Command line of the process: [node, entry script, ...arguments]. Absent in older sessions. */
  argv?: string[];
  /** Directory the process ran in. */
  cwd?: string;
  /** Browser tracks: the document or worker script URL, the frame it belongs to, and its origin. */
  url?: string;
  frameId?: string;
  origin?: string;
}

export interface CdpCallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  /** 0-based, as V8 reports it. */
  lineNumber: number;
  /** 0-based, as V8 reports it. */
  columnNumber: number;
}

export interface CdpProfileNode {
  id: number;
  callFrame: CdpCallFrame;
  hitCount?: number;
  children?: number[];
  positionTicks?: Array<{ line: number; ticks: number }>;
}

/** `Profiler.Profile` as returned by `Profiler.stop` (times in microseconds). */
export interface CdpProfile {
  nodes: CdpProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

export interface ScriptInfo {
  scriptId: string;
  url: string;
  sourceMapURL: string;
  /** V8 content hash. */
  hash: string;
}

/** Epoch milliseconds for `time`; durations in milliseconds. */
export type RuntimeEvent =
  | { type: 'gc'; time: number; duration: number; kind: number }
  | { type: 'loop'; time: number; p50: number; p99: number; max: number }
  | {
      type: 'async';
      time: number;
      phase: 'init' | 'before' | 'after' | 'destroy';
      asyncId: number;
      triggerAsyncId: number;
      asyncType: string;
    }
  | { type: 'request'; time: number; duration: number; method: string; url: string; status: number }
  | { type: 'render'; time: number; duration: number; name: string }
  | { type: 'network'; time: number; duration: number; url: string };

export interface RawTrack {
  info: TrackInfo;
  cpuProfile?: CdpProfile;
  scripts: ScriptInfo[];
  events: RuntimeEvent[];
  /** Exact events on this thread (browser traces): tasks, event dispatch, script and rendering work. */
  timeline?: TimelineEvent[];
  /**
   * V8's deoptimization trace of the process (workers share their process's), reduced by the host to
   * the line that names each deoptimized function and the line that gives its position. Absent when
   * the process was not traced and in older sessions.
   */
  deoptTrace?: string;
}

export type CaptureMode = 'default' | 'fine' | 'async';

export interface CaptureMeta {
  command: string[];
  cwd: string;
  nodeVersion: string;
  platform: string;
  mode: CaptureMode;
  /** Sampling interval in microseconds. */
  intervalUs: number;
  /** Epoch ms. */
  startedAt: number;
  endedAt: number;
  endedBy: 'exit' | 'sigint' | 'duration' | 'crash' | 'stop' | 'window-closed';
  /** Absolute project root: source reads are restricted to it. */
  projectRoot: string;
  /**
   * Processes and workers that registered with the collector but were stopped before they could write a
   * profile. Set by the host; absent in older sessions.
   */
  lostTracks?: Array<{
    id: string;
    pid?: number;
    threadId?: number;
    label?: string;
    kind: 'process' | 'worker';
  }>;
  /**
   * Moments recorded while the program ran, oldest first. `at` is epoch ms, like `startedAt`.
   * `kind` is absent (or `manual`) for marks the user added; browser runs also record user events.
   */
  marks?: RawMark[];
}

export interface RawMark {
  at: number;
  label: string;
  kind?: string;
  /** Joins an automatic event to its `TimeStamp` in the trace. */
  seq?: string;
  frame?: string;
}

/** One exact event from a browser trace. Times are microseconds on the trace's monotonic clock. */
export interface TimelineEvent {
  name: string;
  ts: number;
  dur: number;
  /** The one argument that names it: the event type of an `EventDispatch`, the function of a `FunctionCall`. */
  arg?: string;
  /** A number the event carries: dirty objects of a layout, the score of a layout shift, the size of a paint. */
  n?: number;
}

/** A browser event that belongs to a page rather than to one profiled thread. */
export interface PageEvent extends TimelineEvent {
  pid: number;
}

/** What a browser capture adds to the common shapes. */
export interface BrowserInfo {
  product: string;
  /** The URL the run started on, without query or fragment. */
  url: string;
  /** Extra origins to treat as first-party code. */
  firstParty: string[];
  /**
   * `epoch µs = trace µs + offsetUs`. `anchored` is false when the offset is a guess (a file imported
   * from the DevTools Performance panel has no wall clock).
   */
  clock: { offsetUs: number; errorUs: number; anchored: boolean };
  /** Stretches that were recorded, on the trace clock. Gaps between them were paused. */
  segments: Array<{ startUs: number; endUs: number }>;
  throttle?: number;
  cacheCold?: boolean;
  page: PageEvent[];
  /** Filmstrip frames: the bytes live in the session, next to the model. */
  screenshots: Array<{ id: number; tsUs: number }>;
  traceFilter?: {
    version: number;
    excludedCategories: string[];
    droppedByName: Record<string, number>;
    keptEvents: number;
    droppedEvents: number;
  };
}

/** Everything the engine needs. Source maps are pre-read by the host because the engine does no I/O. */
export interface RawCapture {
  meta: CaptureMeta;
  /** Present for browser captures. */
  browser?: BrowserInfo;
  tracks: RawTrack[];
  /** Source map JSON text keyed by the script URL it belongs to (host-resolved). Inline maps are decoded by the engine. */
  sourceMaps: Record<string, string>;
}
