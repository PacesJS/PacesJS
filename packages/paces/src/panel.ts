import { formatElapsed } from './progress.js';
import type { ProgressState } from './progress.js';

export const PANEL_ROWS = 3;

const MIN_ROWS = 12;
const MIN_COLS = 40;
const FRAME_MS = 120;
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

const ESC = '\u001b';
const SAVE = `${ESC}7`;
const RESTORE = `${ESC}8`;
const RESET_REGION = `${ESC}[r`;
const CLEAR_LINE = `${ESC}[2K`;
const CLEAR_BELOW = `${ESC}[J`;
const NORMAL = `${ESC}[0m`;

type Tone = 'dim' | 'accent' | 'key' | 'warn';
const TONES: Record<Tone, string> = {
  dim: `${ESC}[2m`,
  accent: `${ESC}[1;36m`,
  key: `${ESC}[1;36m`,
  warn: `${ESC}[1;33m`,
};

interface Segment {
  text: string;
  tone?: Tone;
}

const TEXT = {
  profiling: 'profiling',
  mark: ' add a mark',
  stop: ' stop and show results',
  interrupt: 'Ctrl+C stops and shows the results',
  quit: ' stop',
  optOut: 'stdin? use --no-keys',
  noKeys: ' (--no-keys: marks are off)',
  stdinUsed: '! reads stdin: use --no-keys',
} as const;

export interface PanelSize {
  rows: number | undefined;
  cols: number | undefined;
}

interface PanelOptions {
  write(sequence: string): void;
  size(): PanelSize;
  /** Calls back when the terminal changes size; returns what stops it. */
  onResize(listener: () => void): () => void;
  state(): ProgressState;
  now?: () => number;
  /** Colors and emphasis; off for `NO_COLOR`. */
  color?: boolean;
}

/** Scroll regions need room above the panel, and a width that fits a status line. */
export function panelSupported({ rows, cols }: PanelSize): boolean {
  return rows !== undefined && cols !== undefined && rows >= MIN_ROWS && cols >= MIN_COLS;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const SEP: Segment = { text: ' · ', tone: 'dim' };

/** What each key does, with the key names marked so they stand out. */
function keyRow(state: ProgressState): Segment[] {
  if (!state.keys) return [{ text: ` ${TEXT.interrupt}` }, { text: TEXT.noKeys, tone: 'dim' }];
  const pause: Segment[] = state.canPause
    ? [
        { text: 'p', tone: 'key' },
        {
          text:
            state.phase === 'paused' ? ' resume' : state.phase === 'ready' ? ' start' : ' pause',
        },
        SEP,
      ]
    : [];
  return [
    { text: ' ' },
    { text: 'm', tone: 'key' },
    { text: TEXT.mark },
    SEP,
    ...pause,
    { text: 's', tone: 'key' },
    { text: TEXT.stop },
    SEP,
    { text: 'Ctrl+C', tone: 'key' },
    { text: TEXT.quit },
    SEP,
    { text: TEXT.optOut, tone: 'dim' },
  ];
}

/** The panel as styled segments, one array per row, none wider than the terminal. */
function panelRows(
  elapsedMs: number,
  tick: number,
  state: ProgressState,
  cols: number,
): Segment[][] {
  const verb =
    state.phase === 'paused'
      ? 'paused'
      : state.phase === 'ready'
        ? 'ready to record'
        : state.phase === 'collecting'
          ? `collecting trace… ${state.collecting ?? 0}%`
          : state.phase === 'recording'
            ? 'recording'
            : TEXT.profiling;
  const status: Segment[] = [
    { text: ` ${SPINNER[tick % SPINNER.length]} ${verb}`, tone: 'accent' },
    SEP,
    { text: formatElapsed(elapsedMs) },
  ];
  if (state.processes > 0)
    status.push(SEP, { text: plural(state.processes, 'process', 'processes') });
  if (state.marks > 0) status.push(SEP, { text: plural(state.marks, 'mark') });
  // Only while paces holds the keyboard: with --no-keys there is nothing to warn about.
  if (state.keys && state.stdinUsed) status.push(SEP, { text: TEXT.stdinUsed, tone: 'warn' });
  const rule: Segment[] = [{ text: '─'.repeat(cols), tone: 'dim' }];
  return [rule, status, keyRow(state)].map((row) => fit(row, cols));
}

function fit(row: Segment[], cols: number): Segment[] {
  let left = cols;
  const out: Segment[] = [];
  for (const seg of row) {
    if (left <= 0) break;
    out.push(seg.text.length <= left ? seg : { ...seg, text: seg.text.slice(0, left) });
    left -= seg.text.length;
  }
  return out;
}

/** The panel's plain text, one string per row. */
export function panelLines(
  elapsedMs: number,
  tick: number,
  state: ProgressState,
  cols: number,
): string[] {
  return panelRows(elapsedMs, tick, state, cols).map((row) => row.map((s) => s.text).join(''));
}

/**
 * Keeps the bottom rows for a status panel and confines the program's output to the rows above, with
 * a terminal scroll region. The program keeps its real terminal, so colors and isTTY stay as they
 * were. The alternate screen is not used, so its output remains in the scrollback afterwards.
 * Returns what gives the whole screen back.
 */
export function startPanel(options: PanelOptions): () => void {
  const { write, size, onResize, state } = options;
  const now = options.now ?? Date.now;
  const color = options.color ?? true;
  const started = now();
  let tick = 0;
  let dims = { rows: size().rows ?? 0, cols: size().cols ?? 0 };

  const regionEnd = (): number => dims.rows - PANEL_ROWS;
  const setRegion = (): string => `${ESC}[1;${regionEnd()}r`;

  const draw = (): void => {
    const lines = panelRows(now() - started, tick, state(), dims.cols);
    const rows = lines.map((row, i) => {
      const text = row
        .map((seg) => (color && seg.tone ? `${TONES[seg.tone]}${seg.text}${NORMAL}` : seg.text))
        .join('');
      return `${ESC}[${regionEnd() + 1 + i};1H${CLEAR_LINE}${text}`;
    });
    // Save and restore the cursor so drawing never moves where the program writes next.
    write(`${SAVE}${rows.join('')}${RESTORE}`);
  };

  // Scrolling the screen up first makes room without overwriting what is already on it; setting
  // the region homes the cursor, so it is put back at the bottom of the program's rows.
  write(`${'\n'.repeat(PANEL_ROWS)}${ESC}[${PANEL_ROWS}A${setRegion()}${ESC}[${regionEnd()};1H`);
  draw();

  const timer = setInterval(() => {
    tick += 1;
    draw();
  }, FRAME_MS);
  timer.unref();

  const stopResize = onResize(() => {
    const next = size();
    if (!panelSupported(next)) return;
    write(`${SAVE}${RESET_REGION}${ESC}[${regionEnd() + 1};1H${CLEAR_BELOW}`);
    dims = { rows: next.rows ?? dims.rows, cols: next.cols ?? dims.cols };
    write(`${setRegion()}${RESTORE}`);
    draw();
  });

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    stopResize();
    process.off('exit', stop);
    // Resetting the region homes the cursor; put it back where the program left it, so the shell
    // carries on from the last line of output with no gap.
    write(`${SAVE}${RESET_REGION}${RESTORE}${CLEAR_BELOW}`);
  };
  // A crash must not leave the terminal confined to a scroll region.
  process.once('exit', stop);
  return stop;
}
