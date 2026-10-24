export type KeyAction = 'mark' | 'stop' | 'interrupt';

/** What each key press means while profiling. Raw mode turns Ctrl+C into a plain `\u0003`. */
export function keyActions(chunk: string): KeyAction[] {
  const out: KeyAction[] = [];
  for (const ch of chunk) {
    if (ch === 'm' || ch === 'M') out.push('mark');
    else if (ch === 's' || ch === 'S') out.push('stop');
    else if (ch === '\u0003') out.push('interrupt');
  }
  return out;
}

export interface KeysDecision {
  /** `--keys` / `--no-keys`; unset means on. */
  flag: boolean | undefined;
  isTTY: boolean;
}

/**
 * Hotkeys need a terminal and are on unless `--no-keys`. Holding the keyboard means the program
 * cannot read it, so `--no-keys` is the way to leave stdin entirely alone.
 */
export function keysEnabled({ flag, isTTY }: KeysDecision): boolean {
  return isTTY && flag !== false;
}

/** The part of a TTY input stream the hotkeys use. */
export interface KeyInput {
  isTTY?: boolean;
  setRawMode?(on: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

export type KeyHandlers = Record<KeyAction, () => void>;

/** Reads single key presses until the returned function is called, which restores the terminal. */
export function startKeys(input: KeyInput, handlers: KeyHandlers): () => void {
  if (!input.isTTY || !input.setRawMode) return () => {};
  const onData = (chunk: Buffer | string): void => {
    for (const action of keyActions(chunk.toString())) handlers[action]();
  };
  input.setRawMode(true);
  input.on('data', onData);
  input.resume();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    input.off('data', onData);
    input.setRawMode?.(false);
    input.pause();
  };
}
