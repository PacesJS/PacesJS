// Raw capture types: what collectors produce and the engine ingests.
// Collectors speak the Chrome DevTools Protocol, so Node and browsers share these shapes.

export type TrackId = string;

export type TrackKind = 'process' | 'worker' | 'page' | 'frame';

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
  endedBy: 'exit' | 'sigint' | 'duration' | 'crash';
  /** Absolute project root: source reads are restricted to it. */
  projectRoot: string;
}

/** Everything the engine needs. Source maps are pre-read by the host because the engine does no I/O. */
export interface RawCapture {
  meta: CaptureMeta;
  tracks: RawTrack[];
  /** Source map JSON text keyed by the script URL it belongs to (host-resolved). Inline maps are decoded by the engine. */
  sourceMaps: Record<string, string>;
}
