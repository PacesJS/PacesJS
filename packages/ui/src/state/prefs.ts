import { clamp } from '../view/scale';

// Layout preferences: persisted through the host's settings, never part of the URL hash.

export interface WfColumns {
  /** Pixel widths of the CALL, TIME and SHARE columns; the bar column takes the rest. */
  call: number;
  time: number;
  share: number;
}

export type DockOrientation = 'right' | 'bottom';

export interface DockPrefs {
  orientation: DockOrientation;
  /** Share of the content width the right dock takes (0.25 to 0.75). */
  widthFraction: number;
  /** Pixel height of the bottom dock. */
  heightPx: number;
  /** Wrap long source lines instead of scrolling. */
  wrap: boolean;
}

export interface Prefs {
  wfCols: WfColumns;
  dock: DockPrefs;
}

export const WF_COLUMN_LIMITS = {
  call: { min: 160, max: 640 },
  time: { min: 72, max: 160 },
  share: { min: 56, max: 140 },
} as const;

export const DOCK_LIMITS = {
  widthFraction: { min: 0.25, max: 0.75 },
  heightPx: { min: 200, max: 900 },
} as const;

export const DEFAULT_PREFS: Prefs = {
  wfCols: { call: 320, time: 76, share: 60 },
  dock: { orientation: 'right', widthFraction: 0.46, heightPx: 420, wrap: false },
};

/**
 * The user's own say over the dock. It applies while the selection keeps the same answer to
 * "does it have code?" (`forCode`): a collapse made with a function selected lasts until the
 * selection is cleared, and an expand made with nothing selected lasts until something is
 * selected. After that the dock follows the selection again. Width and side are what persist.
 */
export interface DockOverride {
  mode: 'open' | 'collapsed';
  forCode: boolean;
}

/** Whether the dock is a slim rail: it follows the selection unless the user said otherwise. */
export function dockCollapsed(override: DockOverride | null, hasCode: boolean): boolean {
  if (override && override.forCode === hasCode) return override.mode === 'collapsed';
  return !hasCode;
}

export function clampColumns(c: WfColumns): WfColumns {
  return {
    call: clamp(c.call, WF_COLUMN_LIMITS.call.min, WF_COLUMN_LIMITS.call.max),
    time: clamp(c.time, WF_COLUMN_LIMITS.time.min, WF_COLUMN_LIMITS.time.max),
    share: clamp(c.share, WF_COLUMN_LIMITS.share.min, WF_COLUMN_LIMITS.share.max),
  };
}

export function clampDock(d: DockPrefs): DockPrefs {
  return {
    ...d,
    widthFraction: clamp(
      d.widthFraction,
      DOCK_LIMITS.widthFraction.min,
      DOCK_LIMITS.widthFraction.max,
    ),
    heightPx: clamp(d.heightPx, DOCK_LIMITS.heightPx.min, DOCK_LIMITS.heightPx.max),
  };
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

/** Read saved preferences; anything missing or malformed falls back to the defaults. */
export function parsePrefs(raw: unknown): Prefs {
  const r = rec(raw);
  const cols = rec(r['wfCols']);
  const dock = rec(r['dock']);
  return {
    wfCols: clampColumns({
      call: num(cols['call'], DEFAULT_PREFS.wfCols.call),
      time: num(cols['time'], DEFAULT_PREFS.wfCols.time),
      share: num(cols['share'], DEFAULT_PREFS.wfCols.share),
    }),
    dock: clampDock({
      orientation: dock['orientation'] === 'bottom' ? 'bottom' : 'right',
      widthFraction: num(dock['widthFraction'], DEFAULT_PREFS.dock.widthFraction),
      heightPx: num(dock['heightPx'], DEFAULT_PREFS.dock.heightPx),
      wrap: dock['wrap'] === true,
    }),
  };
}
