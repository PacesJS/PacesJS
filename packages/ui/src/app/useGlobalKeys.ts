import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { SelectionInfo } from '../data/queries';
import type { ModelSummary } from '../data/queries';
import type { QueryClient } from '../data/protocol';
import { focusTransform } from '../state/focus';
import { isTypingTarget, resolveKey } from '../state/keymap';
import { snapshotOf } from '../state/reducer';
import type { AppAction, AppState } from '../state/reducer';
import { addTransform } from '../state/transforms';

interface GlobalKeys {
  client: QueryClient;
  dispatch(action: AppAction): void;
  clearCurrent(): void;
  stateRef: RefObject<AppState>;
  selectionRef: RefObject<SelectionInfo>;
  summaryRef: RefObject<ModelSummary>;
  searchRef: RefObject<HTMLInputElement | null>;
}

/** The global shortcut keys: views, search, focus, merge, collapse, invert, back, forward, Escape. */
export function useGlobalKeys({
  client,
  dispatch,
  clearCurrent,
  stateRef,
  selectionRef,
  summaryRef,
  searchRef,
}: GlobalKeys): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const action = resolveKey(e);
      if (!action) return;
      const s = snapshotOf(stateRef.current);
      const sel = selectionRef.current;
      const swallow = (): void => e.preventDefault();
      switch (action.type) {
        case 'view':
          swallow();
          dispatch({ type: 'go', patch: { view: action.view } });
          break;
        case 'focus-search':
          swallow();
          searchRef.current?.focus();
          break;
        case 'focus-subtree': {
          const transform = focusTransform(sel.path, sel.fn, summaryRef.current.functionCount);
          if (transform) {
            swallow();
            dispatch({ type: 'add-transform', transform });
          }
          break;
        }
        case 'merge':
          if (sel.fn !== null) {
            swallow();
            dispatch({ type: 'add-transform', transform: { k: 'merge-fn', fn: sel.fn } });
          }
          break;
        case 'collapse-pkg':
          if (sel.fn !== null) {
            swallow();
            void client.packageOf(sel.fn).then((pkg) => {
              if (pkg) dispatch({ type: 'add-transform', transform: { k: 'collapse-pkg', pkg } });
            });
          }
          break;
        case 'invert':
          swallow();
          dispatch({
            type: 'go',
            patch: { transforms: addTransform(s.transforms, { k: 'invert' }) },
          });
          break;
        case 'critical':
          swallow();
          dispatch({
            type: 'go',
            patch: { view: 'waterfall' },
            options: { pathOnly: !s.options.pathOnly },
          });
          break;
        case 'shortcuts':
          swallow();
          dispatch({ type: 'set-shortcuts', open: true });
          break;
        case 'back':
          swallow();
          dispatch({ type: 'back' });
          break;
        case 'forward':
          swallow();
          dispatch({ type: 'forward' });
          break;
        case 'escape':
          if (stateRef.current.dockMaximized)
            dispatch({ type: 'set-dock-maximized', maximized: false });
          else if (stateRef.current.shortcutsOpen) dispatch({ type: 'set-shortcuts', open: false });
          else if (!isTypingTarget(e.target)) clearCurrent();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [client, dispatch, clearCurrent, stateRef, selectionRef, summaryRef, searchRef]);
}
