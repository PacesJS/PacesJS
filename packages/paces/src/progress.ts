const FIRST_MS = 5_000;
const EVERY_MS = 10_000;

export interface ProgressState {
  /** Processes that have registered with the collector so far. */
  processes: number;
  marks: number;
  /** The hotkeys are on. */
  keys: boolean;
  /** A profiled process has read stdin, which paces is holding for the hotkeys. */
  stdinUsed?: boolean;
  /** Browser runs: the recording can be paused with p. */
  canPause?: boolean;
  /** Browser runs: what the recording is doing. */
  phase?: 'ready' | 'recording' | 'paused' | 'collecting';
  /** Browser runs: percent of the trace read back while saving. */
  collecting?: number;
}

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** One line that says the profile is still running, since a quiet terminal looks like a hang. */
export function progressLine(elapsedMs: number, s: ProgressState): string {
  const parts = ['paces: still profiling', formatElapsed(elapsedMs)];
  if (s.processes > 0) parts.push(count(s.processes, 'process', 'processes'));
  if (s.marks > 0) parts.push(count(s.marks, 'mark'));
  if (s.keys) parts.push('m add a mark', 's stop and show results');
  parts.push('Ctrl+C stops and shows the results');
  return parts.join(' · ');
}

interface ProgressOptions {
  log(line: string): void;
  state(): ProgressState;
  now?: () => number;
}

/** Reports at 5 s and every 10 s after, so a run that finishes quickly prints nothing extra. */
export function startProgress(options: ProgressOptions): () => void {
  const now = options.now ?? Date.now;
  const started = now();
  let next = FIRST_MS;
  const timer = setInterval(() => {
    const elapsed = now() - started;
    if (elapsed < next) return;
    next = elapsed + EVERY_MS;
    options.log(progressLine(elapsed, options.state()));
  }, 1_000);
  timer.unref();
  return () => clearInterval(timer);
}
