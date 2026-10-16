export interface InterruptDeps {
  /** Tell every registered process to stop profiling and flush. */
  sendStop(): void;
  /** Ask the target to run its own SIGINT handling (emulated Ctrl+C). */
  sendSigint(): void;
  /** Hard kill of the target process tree. */
  kill(): void;
  /** Resolves when every registered track has acknowledged its flush (or its socket closed). */
  allFlushed: Promise<void>;
  /** Resolves when the target process has exited. */
  childExited: Promise<unknown>;
  flushTimeoutMs?: number;
  /** A real terminal Ctrl+C also reaches the target; give it this long to leave on its own. */
  exitGraceMs?: number;
}

const after = (ms: number): Promise<'timeout'> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), ms);
    t.unref();
  });

/**
 * R11. First interrupt: `stop`, wait up to 5 s for flush acks, give the target about 1 s to exit by
 * itself, otherwise emulate Ctrl+C inside it. Any later interrupt kills immediately.
 */
export function createInterruptHandler(deps: InterruptDeps): () => Promise<void> {
  let calls = 0;
  let exited = false;
  void deps.childExited.then(() => {
    exited = true;
  });
  return async () => {
    calls++;
    if (calls > 1) {
      deps.kill();
      return;
    }
    deps.sendStop();
    await Promise.race([deps.allFlushed, deps.childExited, after(deps.flushTimeoutMs ?? 5000)]);
    if (exited) return;
    await Promise.race([deps.childExited, after(deps.exitGraceMs ?? 1000)]);
    if (exited) return;
    deps.sendSigint();
  };
}
