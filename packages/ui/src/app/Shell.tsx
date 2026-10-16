import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { HostAdapter } from '../host/adapter';
import type { QueryClient } from '../data/protocol';
import type { ModelSummary, Scope } from '../data/queries';
import { Header } from '../components/Header';
import { fmtRange } from '../util/format';
import { Overview } from '../components/Overview';
import { ShortcutSheet } from '../components/ShortcutSheet';
import { Workspace } from '../components/Workspace';
import { popTarget, stepBrowser, urlAction } from '../state/browser-history';
import type { UrlSync } from '../state/browser-history';
import { hashToSnapshot, snapshotToHash } from '../state/hash';
import { isTypingTarget, resolveKey } from '../state/keymap';
import {
  CLEAR_SELECTION,
  clearShowMeAction,
  hasSelection,
  isShowing,
  showMeContext,
  showingText,
} from '../state/showme';
import type { Prefs } from '../state/prefs';
import { createState, reducer, snapshotOf } from '../state/reducer';
import type { AppAction } from '../state/reducer';
import { addTransform } from '../state/transforms';
import { ALL_TRACKS } from '../state/types';
import type { Selection, Snapshot } from '../state/types';
import { AppContext } from './context';
import type { AppContextValue } from './context';
import { useAsync } from './hooks';

interface ShellProps {
  host: HostAdapter;
  client: QueryClient;
  summary: ModelSummary;
  initial: Snapshot;
  sessionPath?: string;
  initialDismissed: string[];
  initialPinned: string[];
  initialPrefs: Prefs;
}

export function Shell({
  host,
  client,
  summary,
  initial,
  sessionPath,
  initialDismissed,
  initialPinned,
  initialPrefs,
}: ShellProps) {
  const [state, rawDispatch] = useReducer(reducer, initial, (snap) => ({
    ...createState(snap),
    dismissed: initialDismissed,
    pinned: initialPinned,
    prefs: initialPrefs,
  }));
  const snap = snapshotOf(state);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  // Back and forward go through the browser, so its own buttons and these stay one stack.
  const dispatch = useCallback((action: AppAction): void => {
    if (action.type === 'back' || action.type === 'forward') {
      stepBrowser(
        action.type === 'back' ? -1 : 1,
        stateRef.current.history,
        typeof window === 'undefined' ? undefined : window.history,
        rawDispatch,
      );
      return;
    }
    rawDispatch(action);
  }, []);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const scope: Scope = useMemo(
    () => ({
      track: snap.track,
      transforms: snap.transforms,
      range: snap.range,
      hide: snap.options.hide,
    }),
    [snap.track, snap.transforms, snap.range, snap.options.hide],
  );
  const scopeKey = useMemo(() => JSON.stringify(scope), [scope]);

  const describeQ = useAsync(
    () => client.describe(scope, snap.selection),
    `describe:${scopeKey}:${JSON.stringify(snap.selection)}`,
  );
  const selection = useMemo(() => {
    const base = describeQ.data ?? {
      fn: null,
      path: null,
      name: '',
      track: null,
      task: null,
      loc: '',
      plumbing: false,
    };
    return snap.selection.kind === 'fn' ? { ...base, fn: snap.selection.fn } : base;
  }, [describeQ.data, snap.selection]);
  const hoverFn = state.hover.kind === 'fn' ? state.hover.fn : null;
  const primaryTrack = snap.track !== ALL_TRACKS ? snap.track : (summary.tracks[0]?.id ?? '');

  // The URL hash mirrors the screen (a reload or a pasted link restores it), and every new screen
  // is a browser history entry, so the browser's back and forward step through your selections.
  const hash = snapshotToHash(snap);
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
  }, []);
  useEffect(() => {
    const onHash = (): void => {
      const next = hashToSnapshot(location.hash);
      if (snapshotToHash(next) !== snapshotToHash(snapshotOf(stateRef.current))) {
        rawDispatch({ type: 'restore', snapshot: next });
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Persist dismissed hints and pinned tracks through the host.
  const savedRef = useRef(
    JSON.stringify({ d: initialDismissed, p: initialPinned, u: initialPrefs }),
  );
  useEffect(() => {
    const now = JSON.stringify({ d: state.dismissed, p: state.pinned, u: state.prefs });
    if (now === savedRef.current) return;
    savedRef.current = now;
    void host.loadSettings().then((s) =>
      host.saveSettings({
        ...s,
        dismissedHints: state.dismissed,
        pinnedTracks: state.pinned,
        uiPrefs: state.prefs,
      }),
    );
  }, [host, state.dismissed, state.pinned, state.prefs]);

  // Theme override for screenshots and links: ?theme=dark|light
  useEffect(() => {
    const t = new URLSearchParams(location.search).get('theme');
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  }, []);

  useEffect(() => {
    document.title = 'paces';
  }, []);

  const summaryRef = useRef(summary);
  const selectionRef = useRef(selection);
  useEffect(() => {
    selectionRef.current = selection;
    summaryRef.current = summary;
  });

  const select = (selection: Selection): void => dispatch({ type: 'select', selection });

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
        case 'focus-subtree':
          if (sel.path !== null) {
            swallow();
            dispatch({ type: 'add-transform', transform: { k: 'focus-node', path: sel.path } });
          } else if (sel.fn !== null) {
            swallow();
            dispatch({ type: 'add-transform', transform: { k: 'focus-fn', fn: sel.fn } });
          }
          break;
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
          else if (!isTypingTarget(e.target)) {
            const shown = summaryRef.current.findings.find((f) =>
              isShowing(f, s, stateRef.current.search, showMeContext(summaryRef.current)),
            );
            if (shown) dispatch(clearShowMeAction(shown, s));
            else if (hasSelection(s)) dispatch(CLEAR_SELECTION);
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [client, dispatch]);

  const ctx = showMeContext(summary);
  const finding = summary.findings.find((f) => isShowing(f, snap, state.search, ctx));
  const showing = finding
    ? showingText(
        finding,
        selection.name || (snap.range ? fmtRange(snap.range[0], snap.range[1]) : ''),
      )
    : null;

  const value: AppContextValue = {
    host,
    client,
    summary,
    state,
    snap,
    dispatch,
    scope,
    scopeKey,
    selection,
    hoverFn,
    primaryTrack,
    select,
    search: state.search,
  };

  return (
    <AppContext.Provider value={value}>
      <Header searchRef={searchRef} sessionPath={sessionPath} />
      <main className="app-main">
        <Overview />
        <Workspace />
      </main>
      <div aria-live="polite" className="sr-only" role="status">
        {showing ?? (selection.name ? `Selected ${selection.name}` : '')}
      </div>
      {state.shortcutsOpen ? (
        <ShortcutSheet onClose={() => dispatch({ type: 'set-shortcuts', open: false })} />
      ) : null}
    </AppContext.Provider>
  );
}
