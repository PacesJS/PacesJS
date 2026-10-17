import { useEffect, useRef } from 'react';
import type { Dispatch, RefObject } from 'react';
import { popTarget, urlAction } from '../state/browser-history';
import type { UrlSync } from '../state/browser-history';
import { hashToSnapshot, snapshotToHash } from '../state/hash';
import { snapshotOf } from '../state/reducer';
import type { AppAction, AppState } from '../state/reducer';

/**
 * The URL hash mirrors the screen (a reload or a pasted link restores it), and every new screen is a
 * browser history entry, so the browser's back and forward step through your selections.
 */
export function useUrlSync(
  state: AppState,
  hash: string,
  stateRef: RefObject<AppState>,
  rawDispatch: Dispatch<AppAction>,
): void {
  const urlSync = useRef<UrlSync | null>(null);
  useEffect(() => {
    const h = state.history;
    const action = urlAction(urlSync.current, h, hash, location.hash);
    urlSync.current = { serial: h.serial, index: h.index };
    const mark = { i: h.index };
    if (action === 'push') history.pushState(mark, '', hash);
    else if (action === 'stamp' || action === 'replace') history.replaceState(mark, '', hash);
  }, [state.history, hash]);
  useEffect(() => {
    const onPop = (e: PopStateEvent): void => {
      const target = popTarget(stateRef.current.history, e.state);
      if (target.kind === 'goto') rawDispatch({ type: 'goto', index: target.index });
      else rawDispatch({ type: 'restore', snapshot: hashToSnapshot(location.hash) });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [stateRef, rawDispatch]);
  useEffect(() => {
    const onHash = (): void => {
      const next = hashToSnapshot(location.hash);
      if (snapshotToHash(next) !== snapshotToHash(snapshotOf(stateRef.current))) {
        rawDispatch({ type: 'restore', snapshot: next });
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [stateRef, rawDispatch]);
}
