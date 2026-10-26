import type { CaptureMeta } from '../raw.js';

/** One Chrome trace event. The engine reads only the fields below. */
export interface TraceEventIn {
  name: string;
  cat?: string;
  ph: string;
  /** Microseconds on the browser's monotonic clock. */
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  id?: string;
  args?: Record<string, unknown>;
}

/** A stretch that was recorded. The gaps between segments were paused. */
export interface RecordedSegment {
  startUs: number;
  endUs: number;
  /** Host epoch ms right after tracing started: the clock anchor of last resort. */
  hostStartMs: number;
  /** Epoch ms the page reported for each `paces:sync:<n>` stamp. */
  syncs: Array<{ n: number; epochMs: number }>;
}

export interface RecordedScript {
  scriptId: string;
  url: string;
  sourceMapURL: string;
  hash: string;
  /** `page`, `iframe`, `worker`...: the kind of target that parsed it. */
  targetType?: string;
  /** For pages and out-of-process iframes this is also the frame id. */
  targetId?: string;
}

/** What the capture host hands the engine; also what the committed browser fixtures hold. */
export interface BrowserRecordingInput {
  product: string;
  url: string;
  startedAt: number;
  endedAt: number;
  endedBy: CaptureMeta['endedBy'];
  events: TraceEventIn[];
  segments?: RecordedSegment[];
  marks?: Array<{ at: number; label: string; kind: string; seq?: string; frame?: string }>;
  screenshots?: Array<{ id: number; tsUs: number }>;
  scripts?: RecordedScript[];
  sourceMaps?: Record<string, string>;
  filter?: {
    version: number;
    excludedCategories: string[];
    droppedByName: Record<string, number>;
    keptEvents: number;
    droppedEvents: number;
  };
  throttle?: number;
  cacheCold?: boolean;
  firstParty?: string[];
  platform?: string;
  cwd?: string;
  /** The trace has no wall-clock anchor (a DevTools export): `startedAt` is a guess. */
  unanchored?: boolean;
}
