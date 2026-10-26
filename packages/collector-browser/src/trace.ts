/** One Chrome trace event, as `Tracing.dataCollected` delivers it. */
export interface TraceEvent {
  name: string;
  cat?: string;
  ph: string;
  /** Microseconds on the browser's monotonic clock. */
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  id?: string;
  s?: string;
  args?: Record<string, unknown>;
}

/** What the capture host kept and dropped while filtering; echoed into the session manifest. */
export interface TraceFilterStats {
  version: number;
  excludedCategories: string[];
  droppedByName: Record<string, number>;
  keptEvents: number;
  droppedEvents: number;
}
