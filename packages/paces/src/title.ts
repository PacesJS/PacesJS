import { formatElapsed } from './progress.js';

const FRAMES = ['⏳', '⌛'] as const;

/** OSC 0: sets the window or tab title. Nothing is drawn in the output, so the program's own lines are safe. */
export function titleSequence(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1000);
  const frame = FRAMES[seconds % FRAMES.length];
  return `\u001b]0;${frame} paces · profiling ${formatElapsed(elapsedMs)}\u0007`;
}

interface TitleOptions {
  write(sequence: string): void;
  now?: () => number;
}

/**
 * Animates the terminal title while profiling, so a quiet terminal still shows something moving.
 * The title is cleared on stop; the terminal falls back to its own.
 */
export function startTitle({ write, now = Date.now }: TitleOptions): () => void {
  const started = now();
  const draw = (): void => write(titleSequence(now() - started));
  draw();
  const timer = setInterval(draw, 1_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    write('\u001b]0;\u0007');
  };
}
