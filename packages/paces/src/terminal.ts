import { keysEnabled, startKeys } from './keys.js';
import type { KeyInput } from './keys.js';
import { panelSupported, startPanel } from './panel.js';
import type { PanelSize } from './panel.js';
import type { ProfileControls } from './profile.js';
import { startProgress } from './progress.js';
import type { ProgressState } from './progress.js';
import { startTitle } from './title.js';

const TEXT = {
  keysOn:
    'paces: keys: m = add a mark, s = stop and show the results, Ctrl+C = stop and let it exit. A program that reads stdin needs --no-keys.',
  needsTerminal: 'paces: --keys needs a terminal; there is none, so the keys stay off.',
  stdinUsed:
    'paces: the program reads stdin, but paces is holding the keyboard for its keys, so it gets no input. Rerun with --no-keys to give it the keyboard.',
  stopping: 'paces: stopping and building the results...',
} as const;

interface TerminalOptions {
  controls: ProfileControls;
  /** `--keys` / `--no-keys`; unset means on in a terminal. */
  flag: boolean | undefined;
  input: KeyInput;
  isTTY: boolean;
  log(line: string): void;
  /** Writes a terminal title sequence; the title is animated only on a terminal. */
  title(sequence: string): void;
  /** The terminal to draw the status panel on; unset keeps to a line now and then. */
  panel?: {
    write(sequence: string): void;
    size(): PanelSize;
    onResize(listener: () => void): () => void;
    color?: boolean;
  };
}

/**
 * The terminal side of a profile in progress: the status panel (or a line now and then), the title
 * and the hotkeys. The hotkeys take the keyboard from the start unless `--no-keys`; that mode never
 * touches stdin. Returns what undoes it all.
 */
export function attachTerminal({
  controls,
  flag,
  input,
  isTTY,
  log,
  title,
  panel,
}: TerminalOptions): () => void {
  let stopKeys: (() => void) | undefined;
  const keysOn = (): boolean => stopKeys !== undefined;

  const takeKeys = (): void => {
    stopKeys = startKeys(input, {
      mark: () => void controls.mark(),
      stop: () => {
        log(TEXT.stopping);
        controls.stop();
      },
      pause: () => controls.togglePause?.(),
      interrupt: controls.interrupt,
    });
    log(TEXT.keysOn);
  };
  if (keysEnabled({ flag, isTTY })) {
    takeKeys();
    controls.onStdinUsed(() => log(TEXT.stdinUsed));
  } else if (flag === true) {
    log(TEXT.needsTerminal);
  }

  const liveState = (): ProgressState => ({
    ...controls.state(),
    ...(controls.togglePause ? { canPause: true } : {}),
    ...(controls.browserState ? controls.browserState() : {}),
    keys: keysOn(),
    stdinUsed: controls.stdinUsed(),
  });
  // The panel already says it is running, so the periodic lines would only be noise inside it.
  const stopStatus =
    panel && panelSupported(panel.size())
      ? startPanel({ ...panel, state: liveState })
      : startProgress({ log, state: liveState });

  const stopTitle = isTTY ? startTitle({ write: title }) : undefined;

  return () => {
    stopStatus();
    stopTitle?.();
    stopKeys?.();
    stopKeys = undefined;
  };
}
