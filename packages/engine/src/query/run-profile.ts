import type { ExecutionModel, RunKind } from '../model.js';

/**
 * What differs between kinds of run when the waterfall is laid out. The kind is looked up once, here;
 * the waterfall only asks the profile, so a new kind of run is a new entry and no new branch.
 */
export interface RunProfile {
  /** Busy time below which a task is small and folded into a summary row. */
  smallTaskUs(trackDurationUs: number): number;
  /** A summary row of small tasks ends at an idle stretch this long. */
  groupGapUs: number;
}

const COMMAND: RunProfile = {
  smallTaskUs: (duration) => Math.max(500, 0.001 * duration),
  groupGapUs: Number.POSITIVE_INFINITY,
};

// A page runs thousands of tasks of a fraction of a millisecond; listing them one by one buries the
// few that matter, and an idle stretch between bursts is where one group should end and the next begin.
const PAGE: RunProfile = {
  smallTaskUs: () => 5000,
  groupGapUs: 100_000,
};

const BY_KIND: Record<RunKind, RunProfile> = {
  server: COMMAND,
  cli: COMMAND,
  script: COMMAND,
  page: PAGE,
};

export const profileOf = (model: ExecutionModel): RunProfile => BY_KIND[model.target.kind];
