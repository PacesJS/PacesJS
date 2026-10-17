import {
  back,
  canBack,
  canForward,
  createHistory,
  current,
  forward,
  goto,
  push,
  replace,
} from './history';
import type { History } from './history';
import { addTransform, removeTransform, rewindTo } from './transforms';
import { DEFAULT_PREFS } from './prefs';
import type { DockOverride, Prefs } from './prefs';
import type { Selection, Snapshot, Transform, ViewOptions } from './types';

export interface AppState {
  history: History;
  hover: Selection;
  /** The dock is shown full screen (the Expand button). */
  dockMaximized: boolean;
  /** The user's collapse or expand of the dock; see `dockCollapsed`. */
  dockOverride: DockOverride | null;
  shortcutsOpen: boolean;
  /** Ids of dismissed first-run hints (also persisted through settings). */
  dismissed: string[];
  search: string;
  /** Track ids pinned to the top of the overview band. */
  pinned: string[];
  /** Layout preferences (column widths, dock), persisted through the host. */
  prefs: Prefs;
  /** The notes chip was dismissed for this session. */
  notesDismissed: boolean;
}

export type AppAction =
  | { type: 'go'; patch: Partial<Snapshot>; options?: Partial<ViewOptions>; search?: string }
  | { type: 'select'; selection: Selection }
  | { type: 'add-transform'; transform: Transform }
  | { type: 'remove-transform'; index: number }
  | { type: 'rewind-transform'; index: number }
  | { type: 'options'; options: Partial<ViewOptions>; replace?: boolean }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'goto'; index: number }
  | { type: 'restore'; snapshot: Snapshot }
  | { type: 'hover'; selection: Selection }
  | { type: 'set-dock-override'; override: DockOverride | null }
  | { type: 'set-dock-maximized'; maximized: boolean }
  | { type: 'set-shortcuts'; open: boolean }
  | { type: 'dismiss-hint'; id: string }
  | { type: 'search'; text: string }
  | { type: 'toggle-pin'; track: string }
  | { type: 'prefs'; prefs: Partial<Prefs> }
  | { type: 'dismiss-notes' };

export function createState(initial: Snapshot): AppState {
  return {
    history: createHistory(initial),
    hover: { kind: 'none' },
    dockMaximized: false,
    dockOverride: null,
    shortcutsOpen: false,
    dismissed: [],
    search: '',
    pinned: [],
    prefs: DEFAULT_PREFS,
    notesDismissed: false,
  };
}

export const snapshotOf = (s: AppState): Snapshot => current(s.history);

/** The flame zoom path is made of node ids of the transformed tree: reset it when that tree changes. */
function commit(state: AppState, next: Snapshot): AppState {
  const prev = snapshotOf(state);
  const treeChanged =
    prev.track !== next.track ||
    JSON.stringify(prev.transforms) !== JSON.stringify(next.transforms) ||
    JSON.stringify(prev.range) !== JSON.stringify(next.range) ||
    JSON.stringify(prev.options.hide) !== JSON.stringify(next.options.hide);
  const selectionChanged =
    JSON.stringify(prev.selection) !== JSON.stringify(next.selection) &&
    next.options.line === prev.options.line;
  const moved = selectionChanged ? { ...next, options: { ...next.options, line: 0 } } : next;
  const snap =
    treeChanged && moved.options.zoom === prev.options.zoom && moved.options.zoom.length > 0
      ? { ...moved, options: { ...moved.options, zoom: [] } }
      : moved;
  return { ...state, history: push(state.history, snap) };
}

export function reducer(state: AppState, action: AppAction): AppState {
  const snap = snapshotOf(state);
  switch (action.type) {
    case 'go': {
      const next = commit(state, {
        ...snap,
        ...action.patch,
        options: { ...snap.options, ...action.patch.options, ...action.options },
      });
      return action.search === undefined ? next : { ...next, search: action.search };
    }
    case 'select':
      return commit(state, { ...snap, selection: action.selection });
    case 'add-transform':
      return commit(state, {
        ...snap,
        transforms: addTransform(snap.transforms, action.transform),
      });
    case 'remove-transform':
      return commit(state, { ...snap, transforms: removeTransform(snap.transforms, action.index) });
    case 'rewind-transform':
      return commit(state, { ...snap, transforms: rewindTo(snap.transforms, action.index) });
    case 'options': {
      const next = { ...snap, options: { ...snap.options, ...action.options } };
      return action.replace
        ? { ...state, history: replace(state.history, next) }
        : commit(state, next);
    }
    case 'back':
      return canBack(state.history) ? { ...state, history: back(state.history) } : state;
    case 'forward':
      return canForward(state.history) ? { ...state, history: forward(state.history) } : state;
    case 'goto':
      return { ...state, history: goto(state.history, action.index) };
    case 'restore':
      // The URL changed under us (a pasted link, or the browser moved to an entry we do not have):
      // adopt it in place; the browser already holds the entry, so the stack must not grow.
      return { ...state, history: replace(state.history, action.snapshot) };
    case 'hover':
      return { ...state, hover: action.selection };
    case 'set-dock-override':
      return { ...state, dockOverride: action.override };
    case 'set-dock-maximized':
      return { ...state, dockMaximized: action.maximized };
    case 'set-shortcuts':
      return { ...state, shortcutsOpen: action.open };
    case 'dismiss-hint':
      return state.dismissed.includes(action.id)
        ? state
        : { ...state, dismissed: [...state.dismissed, action.id] };
    case 'search':
      return { ...state, search: action.text };
    case 'toggle-pin':
      return {
        ...state,
        pinned: state.pinned.includes(action.track)
          ? state.pinned.filter((t) => t !== action.track)
          : [...state.pinned, action.track],
      };
    case 'dismiss-notes':
      return { ...state, notesDismissed: true };
    case 'prefs':
      return { ...state, prefs: { ...state.prefs, ...action.prefs } };
  }
}
