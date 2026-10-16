// The browser's own history and the in-app history are one stack: every new screen is a browser
// entry, so the mouse back button, the browser's arrows and swipe-back step through the same
// selections as the header buttons and Alt+←/→. Each browser entry carries its position in the
// app stack (`history.state.i`) so a back or forward lands on the matching snapshot.

import { canBack, canForward } from './history';
import type { History } from './history';

/** What the URL layer last saw of the app history. */
export interface UrlSync {
  serial: number;
  index: number;
}

export type UrlAction = 'stamp' | 'push' | 'replace' | 'none';

/**
 * How the URL should follow a change of the app history:
 * - `stamp`: first sight, mark the opening entry with its position;
 * - `push`: a new entry was made, so the browser gets a new entry too;
 * - `none`: the browser moved the pointer itself (the URL is already right), or nothing changed;
 * - `replace`: the same entry was edited (a drag, an option), so the URL is rewritten in place.
 */
export function urlAction(
  last: UrlSync | null,
  h: History,
  hash: string,
  currentHash: string,
): UrlAction {
  if (last === null) return 'stamp';
  if (h.serial !== last.serial) return 'push';
  if (h.index !== last.index) return 'none';
  return currentHash === hash ? 'none' : 'replace';
}

export type PopTarget = { kind: 'goto'; index: number } | { kind: 'restore' };

/**
 * What a browser back or forward means for the app: step to the in-app entry the browser entry
 * names, or, for an entry from before this page load (or a pasted link), adopt the URL.
 */
export function popTarget(h: History, browserState: unknown): PopTarget {
  const i = (browserState as { i?: unknown } | null)?.i;
  if (typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < h.entries.length) {
    return { kind: 'goto', index: i };
  }
  return { kind: 'restore' };
}

/** The slice of `window.history` that stepping needs. */
export interface BrowserHistory {
  go(delta: number): void;
}

/**
 * Back (-1) or forward (+1). Goes through the browser so both stacks stay in lockstep; the
 * resulting `popstate` moves the app pointer. Without a browser history the app stack moves itself.
 */
export function stepBrowser(
  dir: -1 | 1,
  h: History,
  browser: BrowserHistory | undefined,
  dispatch: (action: { type: 'back' } | { type: 'forward' }) => void,
): void {
  if (dir < 0 ? !canBack(h) : !canForward(h)) return;
  if (browser) browser.go(dir);
  else dispatch(dir < 0 ? { type: 'back' } : { type: 'forward' });
}
