import type { Thresholds } from '../config.js';
import type { ExecutionModel, Finding, OriginId, RunKind } from '../model.js';
import type { TargetDetection } from '../passes/target.js';
import type { IngestResult, PassContext, TargetSpec } from '../passes/types.js';
import type { RawCapture } from '../raw.js';

export type FindingRule = (model: ExecutionModel, th: Thresholds) => Finding[];

export interface FrameFacts {
  name: string;
  file: string;
  line: number;
}

export interface ClassifiedFunction {
  origin: OriginId;
  /** Package or host the function belongs to; '' for none. */
  pkg: string;
}

/**
 * The parts of an analysis that depend on what was profiled. A capture picks one adapter once, and the
 * passes call it, so no pass asks "is this a browser?". Adding a kind of run adds an adapter.
 */
export interface RunAdapter {
  /** The kind of run, when how it was captured already says (a page); otherwise it is worked out. */
  fixedRunKind?: RunKind;
  /** Which track is the program, and what counts as its own code. */
  detectTarget(capture: RawCapture, ingest: IngestResult, ctx: PassContext): TargetDetection;
  /** The origin of one function. `forced` is a caller's override, which wins over the rules. */
  classifyFunction(
    frame: FrameFacts,
    target: TargetSpec | undefined,
    forced: OriginId | undefined,
  ): ClassifiedFunction;
  /** The finding rules that apply to this kind of run. */
  rules: readonly FindingRule[];
}
