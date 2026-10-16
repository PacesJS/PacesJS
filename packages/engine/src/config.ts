// Analysis configuration. Thresholds are echoed inside every finding's `rule` text.

export interface Thresholds {
  /** Event loop blocked: a non-startup task longer than this (ms). */
  longTaskMs: number;
  /** Hot function: user function self time above this share of busy time. */
  hotFunctionShare: number;
  /** Hot dependency: package total time (excluding plumbing self time) above this share of busy time. */
  hotDependencyShare: number;
  /** GC pressure: GC share of wall time. */
  gcShare: number;
  /** GC pressure: a single pause longer than this (ms). */
  gcPauseMs: number;
  /** Async overhead: plumbing self time above this share of a task kind's busy time. */
  plumbingShare: number;
  /** Heavy serialization: JSON.parse/stringify total above this share of busy time. */
  serializationShare: number;
  /** Event-loop lag: p99 loop delay above this (ms). */
  loopLagP99Ms: number;
  /** Synchronous I/O: ignore fewer total milliseconds than this inside request and timer tasks. */
  syncIoMinMs: number;
  /** Late module loading: ignore fewer total milliseconds than this inside request tasks. */
  lateLoadMinMs: number;
  /** Findings that need a share ignore tracks or kinds with fewer busy samples than this. */
  minSamples: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  longTaskMs: 50,
  hotFunctionShare: 0.1,
  hotDependencyShare: 0.2,
  gcShare: 0.1,
  gcPauseMs: 50,
  plumbingShare: 0.15,
  serializationShare: 0.05,
  loopLagP99Ms: 100,
  syncIoMinMs: 5,
  lateLoadMinMs: 5,
  minSamples: 20,
};

export type OriginName = 'user' | 'dependency' | 'framework' | 'node' | 'native';

export interface AnalyzeOptions {
  thresholds?: Partial<Thresholds>;
  /**
   * Regular expression source -> origin. Tested against the function's normalized file path;
   * the first matching entry (in key order) wins over the built-in rules.
   */
  classification?: Record<string, OriginName>;
  /** Regular expression sources tested against `<file>#<function name>`; a match marks plumbing. */
  plumbingPatterns?: string[];
}

export const ENGINE_VERSION = '0.1.0';
