/** A moment the user flagged while profiling, in microseconds from the start of the run. */
export interface RunMark {
  us: number;
  label: string;
}

/** Marks recorded as epoch ms, placed on the run's timeline in time order and kept inside it. */
export function runMarks(
  marks: ReadonlyArray<{ at: number; label: string; kind?: string }> | undefined,
  startedAt: number,
  durationUs: number,
): RunMark[] {
  // A browser run also records the page's own events (clicks, typing, navigations) as marks; only
  // the ones the user added are flags.
  return (marks ?? [])
    .filter((m) => m.kind === undefined || m.kind === 'manual')
    .map((m) => ({
      us: Math.min(durationUs, Math.max(0, Math.round((m.at - startedAt) * 1000))),
      label: m.label,
    }))
    .sort((a, b) => a.us - b.us);
}
