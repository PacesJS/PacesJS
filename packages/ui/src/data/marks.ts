/** A moment the user flagged while profiling, in microseconds from the start of the run. */
export interface RunMark {
  us: number;
  label: string;
}

/** Marks recorded as epoch ms, placed on the run's timeline in time order and kept inside it. */
export function runMarks(
  marks: ReadonlyArray<{ at: number; label: string }> | undefined,
  startedAt: number,
  durationUs: number,
): RunMark[] {
  return (marks ?? [])
    .map((m) => ({
      us: Math.min(durationUs, Math.max(0, Math.round((m.at - startedAt) * 1000))),
      label: m.label,
    }))
    .sort((a, b) => a.us - b.us);
}
