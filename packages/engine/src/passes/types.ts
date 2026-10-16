// Shared shapes between passes. Every pass is `(input, ctx) => output`.

import type { AnalyzeOptions, Thresholds } from '../config.js';
import type { Samples, EventTable } from '../model.js';
import type { RawCapture, ScriptInfo, TrackInfo } from '../raw.js';
import type { StringTable } from '../util/strings.js';

export interface PassContext {
  thresholds: Thresholds;
  options: AnalyzeOptions;
  strings: StringTable;
  warnings: string[];
}

/** Distinct (name, url, line, column) tuples across all tracks, before source mapping. */
export interface FrameTable {
  length: number;
  name: Uint32Array;
  url: Uint32Array;
  /** 0-based as V8 reports it; -1 for native frames. */
  line: Int32Array;
  col: Int32Array;
}

/** Raw call tree in preorder (node 0 is `(root)`); `frame` indexes `FrameTable`. */
export interface RawTree {
  length: number;
  parent: Int32Array;
  frame: Uint32Array;
  depth: Uint16Array;
  subtreeEnd: Uint32Array;
  self: Float64Array;
  total: Float64Array;
  /** Samples that landed exactly on this node. */
  hits: Uint32Array;
}

/** V8 `positionTicks` in CSR layout per node: entries of node n are [offset[n], offset[n+1]). */
export interface RawTicks {
  offset: Uint32Array;
  /** 1-based generated line. */
  line: Uint32Array;
  ticks: Uint32Array;
}

export interface AsyncRecords {
  length: number;
  /** Microseconds since `meta.startedAt`. */
  time: Float64Array;
  /** 0 init, 1 before, 2 after, 3 destroy. */
  phase: Uint8Array;
  asyncId: Float64Array;
  triggerAsyncId: Float64Array;
}

export interface IngestedTrack {
  info: TrackInfo;
  tree: RawTree;
  samples: Samples;
  ticks: RawTicks;
  events: EventTable;
  async: AsyncRecords;
  scripts: ScriptInfo[];
}

export interface IngestResult {
  frames: FrameTable;
  tracks: IngestedTrack[];
  /** Measured sampling interval (microseconds): the larger of the configured and the median gap. */
  precisionUs: number;
  durationUs: number;
}

export type IngestInput = RawCapture;
