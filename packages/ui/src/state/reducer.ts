import {
  back,
  canBack,
  canForward,
  createHistory,
  current,
  forward,
  push,
  replace,
} from './history';
import type { History } from './history';
import { addTransform, removeTransform, rewindTo } from './transforms';
import type { Selection, Snapshot, Transform, ViewOptions } from './types';

export interface AppState {
  history: History;
  hover: Selection;
  sourceCollapsed: boolean;
  shortcutsOpen: boolean;
  /** Ids of dismissed first-run hints (also persisted through settings). */
  dismissed: string[];
  search: string;
  /** Track ids pinned to the top of the overview band. */
  pinned: string[];
}

export type AppAction =
  | { type: 'go'; patch: Partial<Snapshot>; options?: Partial<ViewOptions> }
  | { type: 'select'; selection: Selection }
  | { type: 'add-transform'; transform: Transform }
  | { type: 'remove-transform'; index: number }
  | { type: 'rewind-transform'; index: number }
  | { type: 'options'; options: Partial<ViewOptions>; replace?: boolean }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'restore'; snapshot: Snapshot }
  | { type: 'hover'; selection: Selection }
  | { type: 'set-source-collapsed'; collapsed: boolean }
  | { type: 'set-shortcuts'; open: boolean }
  | { type: 'dismiss-hint'; id: string }
  | { type: 'set-dismissed'; ids: string[] }
  | { type: 'search'; text: string }
  | { type: 'toggle-pin'; track: string }
  | { type: 'set-pinned'; tracks: string[] };

export function createState(initial: Snapshot): AppState {
  return {
    history: createHistory(initial),
    hover: { kind: 'none' },
    sourceCollapsed: false,
    shortcutsOpen: false,
    dismissed: [],
    search: '',
    pinned: [],
  };
}

export const snapshotOf = (s: AppState): Snapshot => current(s.history);

/** The flame zoom path is made of node ids of the transformed tree: reset it when that tree changes. */
function commit(state: AppState, next: Snapshot): AppState {
  const prev = snapshotOf(state);
  const treeChanged =
    prev.track !== next.track ||
    JSON.stringify(prev.transforms) !== JSON.stringify(next.transforms) ||
    JSON.stringify(prev.range) !== JSON.stringify(next.range);
  const snap =
    treeChanged && next.options.zoom === prev.options.zoom && next.options.zoom.length > 0
      ? { ...next, options: { ...next.options, zoom: [] } }
      : next;
  return { ...state, history: push(state.history, snap) };
}

export function reducer(state: AppState, action: AppAction): AppState {
  const snap = snapshotOf(state);
  switch (action.type) {
    case 'go':
      return commit(state, {
        ...snap,
        ...action.patch,
        options: { ...snap.options, ...action.patch.options, ...action.options },
      });
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
    case 'restore':
      return { ...state, history: push(state.history, action.snapshot) };
    case 'hover':
      return { ...state, hover: action.selection };
    case 'set-source-collapsed':
      return { ...state, sourceCollapsed: action.collapsed };
    case 'set-shortcuts':
      return { ...state, shortcutsOpen: action.open };
    case 'dismiss-hint':
      return state.dismissed.includes(action.id)
        ? state
        : { ...state, dismissed: [...state.dismissed, action.id] };
    case 'set-dismissed':
      return { ...state, dismissed: action.ids };
    case 'search':
      return { ...state, search: action.text };
    case 'toggle-pin':
      return {
        ...state,
        pinned: state.pinned.includes(action.track)
          ? state.pinned.filter((t) => t !== action.track)
          : [...state.pinned, action.track],
      };
    case 'set-pinned':
      return { ...state, pinned: action.tracks };
  }
}
