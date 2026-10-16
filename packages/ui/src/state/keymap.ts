import type { ViewId } from './types';

export type KeyAction =
  | { type: 'view'; view: ViewId }
  | { type: 'focus-search' }
  | { type: 'focus-subtree' }
  | { type: 'merge' }
  | { type: 'collapse-pkg' }
  | { type: 'invert' }
  | { type: 'critical' }
  | { type: 'shortcuts' }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'escape' };

export interface KeyEventLike {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  target?: EventTarget | { tagName?: string; isContentEditable?: boolean } | null;
}

const VIEW_KEYS: Record<string, ViewId> = {
  '1': 'waterfall',
  '2': 'flame',
  '3': 'callgraph',
  '4': 'functions',
};

const LETTER_ACTIONS: Record<string, KeyAction> = {
  f: { type: 'focus-subtree' },
  m: { type: 'merge' },
  c: { type: 'collapse-pkg' },
  i: { type: 'invert' },
  p: { type: 'critical' },
};

export function isTypingTarget(target: KeyEventLike['target']): boolean {
  if (!target) return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  const tag = (el.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

export interface KeyShortcut {
  keys: string;
  label: string;
}

export const SHORTCUTS: readonly KeyShortcut[] = [
  { keys: '1 2 3 4', label: 'Waterfall, Flame graph, Call graph, Functions' },
  { keys: '/', label: 'Search functions, files and packages' },
  { keys: 'f', label: 'Focus on the selected subtree' },
  { keys: 'm', label: 'Merge the selected function into its callers' },
  { keys: 'c', label: 'Collapse the selected function’s package' },
  { keys: 'i', label: 'Invert the call tree' },
  {
    keys: 'p',
    label: 'Collapse the waterfall to the critical path (press again to expand)',
  },
  { keys: 'Alt+←  Alt+→', label: 'Back and forward through selections, views and transforms' },
  { keys: '↑ ↓ ← →', label: 'Walk waterfall rows, collapse and expand' },
  { keys: 'Enter', label: 'Open the source dock for the selected row' },
  { keys: 'Esc', label: 'Clear the selection (the source dock collapses with it)' },
  { keys: 'Backspace', label: 'Back (in the waterfall)' },
  { keys: '?', label: 'Show this sheet' },
];

/** Map a key event to an action. Plain keys are ignored while typing in a field. */
export function resolveKey(e: KeyEventLike): KeyAction | null {
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    if (e.key === 'ArrowLeft') return { type: 'back' };
    if (e.key === 'ArrowRight') return { type: 'forward' };
    return null;
  }
  if (e.ctrlKey || e.metaKey) return null;
  if (e.key === 'Escape') return { type: 'escape' };
  if (isTypingTarget(e.target)) return null;
  const view = VIEW_KEYS[e.key];
  if (view) return { type: 'view', view };
  if (e.key === '/') return { type: 'focus-search' };
  if (e.key === '?') return { type: 'shortcuts' };
  return LETTER_ACTIONS[e.key.toLowerCase()] ?? null;
}
