// Analysis configuration. Thresholds are echoed inside every finding's `rule` text.

import type { FindingKind, RunKind } from './model.js';

export interface Thresholds {
  /** Event loop blocked: a non-startup task longer than this (ms). */
  longTaskMs: number;
  /** Hot function: user function self time above this share of busy time. */
  hotFunctionShare: number;
  /** Hot path: the deepest call chain in target code that still carries this share of busy time. */
  hotPathShare: number;
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
  /** V8 deopt: a function is flagged after this many deopts for one actionable reason. */
  deoptMinCount: number;
  /** V8 deopt: and only if its own time is above this share of busy time. */
  deoptMinShare: number;
  /** Browser: a main-thread task longer than this blocked the page (ms). */
  mainThreadBlockedMs: number;
  /** Browser: an input whose next paint is later than this is a slow interaction (ms). */
  slowInteractionMs: number;
  /** Browser: more layouts than this in one task, or more than `forcedLayoutMs` of them, is a forced layout. */
  forcedLayoutCount: number;
  forcedLayoutMs: number;
  /** Browser: third-party scripts above this share of main-thread busy time. */
  thirdPartyShare: number;
  /** Browser: cumulative layout shift at or above this score. */
  layoutShiftScore: number;
  /** Browser: a text file this large (decoded bytes) that was sent without compression. */
  uncompressedTextBytes: number;
  /** Browser: the largest content appeared later than this. */
  slowLoadMs: number;
  /** Browser: the page's HTML took longer than this to start arriving. */
  documentWaitMs: number;
  /** Findings that need a share ignore tracks or kinds with fewer busy samples than this. */
  minSamples: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  longTaskMs: 50,
  hotFunctionShare: 0.1,
  hotPathShare: 0.1,
  hotDependencyShare: 0.2,
  gcShare: 0.1,
  gcPauseMs: 50,
  plumbingShare: 0.15,
  serializationShare: 0.05,
  loopLagP99Ms: 100,
  syncIoMinMs: 5,
  lateLoadMinMs: 5,
  deoptMinCount: 3,
  deoptMinShare: 0.05,
  mainThreadBlockedMs: 50,
  slowInteractionMs: 200,
  forcedLayoutCount: 10,
  forcedLayoutMs: 20,
  thirdPartyShare: 0.1,
  layoutShiftScore: 0.1,
  uncompressedTextBytes: 20_000,
  slowLoadMs: 2500,
  documentWaitMs: 800,
  minSamples: 20,
};

/** Finding kinds that are not actionable for a batch command and are dropped for `cli` and `script` runs. */
export const DEFAULT_SUPPRESS_FOR_CLI: readonly FindingKind[] = [
  'event-loop-lag',
  'event-loop-blocked',
];

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
  /**
   * Explicit target: npm package names (`eslint`, `@scope/tool`) and/or path globs (`src/**`, tested
   * against the file path as the model stores it: project-relative inside the root, absolute outside).
   * Matching functions become first-party (origin `user`). Replaces the package derived from the entry script.
   */
  focus?: string[];
  /**
   * Attach `(program)` and `(garbage collector)` samples that interrupt a call as leaf children of the deepest
   * frame the stacks before and after share, so the call stays one span (default true). Totals are unchanged.
   */
  bridgeRuntimeSamples?: boolean;
  /** Overrides the detected run kind (server, cli or script). */
  runKind?: RunKind;
  /** Finding kinds dropped for non-server runs. Default: event-loop-lag and event-loop-blocked. */
  suppressForCli?: FindingKind[];
}

export const ENGINE_VERSION = '0.8.2';
