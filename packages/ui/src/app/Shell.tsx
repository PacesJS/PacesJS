import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { HostAdapter } from '../host/adapter';
import type { QueryClient } from '../data/protocol';
import type { ModelSummary, Scope, SelectionInfo } from '../data/queries';
import { Header } from '../components/Header';
import { focusTransform } from '../state/focus';
import { clicksOff, onScrollbar } from './click-off';
import type { PointerStart } from './click-off';
import { dockCollapsed as dockIsCollapsed } from '../state/prefs';
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

const EMPTY_SELECTION: SelectionInfo = {
  fn: null,
  path: null,
  name: '',
  track: null,
  task: null,
  loc: '',
  plumbing: false,
};

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
  const selection = useMemo((): SelectionInfo => {
    const sel = snap.selection;
    // What the selection is, known at once from the selection itself; the query adds names.
    if (sel.kind === 'none' || sel.kind === 'range') return EMPTY_SELECTION;
    const base = describeQ.loading ? EMPTY_SELECTION : (describeQ.data ?? EMPTY_SELECTION);
    if (sel.kind === 'fn') return { ...base, fn: sel.fn };
    if (sel.kind === 'node') {
      return { ...base, fn: sel.path[sel.path.length - 1] ?? null, path: sel.path };
    }
    return base;
  }, [describeQ.data, describeQ.loading, snap.selection]);
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

  /** Clear what is selected, undoing a finding's Show me when that is what is showing. */
  const clearCurrent = useCallback((): void => {
    const s = snapshotOf(stateRef.current);
    const shown = summaryRef.current.findings.find((f) =>
      isShowing(f, s, stateRef.current.search, showMeContext(summaryRef.current)),
    );
    if (shown) dispatch(clearShowMeAction(shown, s));
    else if (hasSelection(s)) dispatch(CLEAR_SELECTION);
  }, [dispatch]);

  // Click-off: one listener for the whole app. A click on anything that is not interactive and
  // not what the user is working with clears the selection (see click-off.ts for the rules).
  useEffect(() => {
    let start: PointerStart | null = null;
    const popoverOpen = (): boolean =>
      document.querySelector('[role="menu"], [role="dialog"]:not([aria-modal="true"])') !== null;
    const onDown = (e: PointerEvent): void => {
      const target = e.target instanceof Element ? e.target : null;
      start = {
        x: e.clientX,
        y: e.clientY,
        target,
        blocked: popoverOpen() || (target ? onScrollbar(target, e.clientX, e.clientY) : false),
      };
    };
    const onClick = (e: MouseEvent): void => {
      const target = e.target instanceof Element ? e.target : null;
      const begun = start;
      start = null;
      const blocked = begun?.blocked === true;
      const off = clicksOff(
        begun ? { ...begun, blocked } : null,
        { x: e.clientX, y: e.clientY, target },
        {
          selectedText: window.getSelection()?.toString() ?? '',
          popoverOpen: false,
          modalOpen: document.querySelector('[aria-modal="true"]') !== null,
        },
      );
      if (off) clearCurrent();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('click', onClick);
    };
  }, [clearCurrent]);

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
  }, [client, dispatch, clearCurrent]);

  const ctx = showMeContext(summary);
  const finding = summary.findings.find((f) => isShowing(f, snap, state.search, ctx));
  const showing = finding
    ? showingText(
        finding,
        selection.name || (snap.range ? fmtRange(snap.range[0], snap.range[1]) : ''),
      )
    : null;

  // The dock follows the selection: slim when nothing with code is selected, extended otherwise.
  const hasCode = selection.fn !== null && selection.fn < summary.functionCount;
  const dockCollapsed = dockIsCollapsed(state.dockOverride, hasCode);
  // The user's say ends when the selection changes between "has code" and "has none".
  const overrideFor = state.dockOverride?.forCode;
  useEffect(() => {
    if (overrideFor !== undefined && overrideFor !== hasCode) {
      dispatch({ type: 'set-dock-override', override: null });
    }
  }, [overrideFor, hasCode, dispatch]);
  const openDock = (): void =>
    dispatch({ type: 'set-dock-override', override: { mode: 'open', forCode: hasCode } });
  const collapseDock = (): void =>
    dispatch({ type: 'set-dock-override', override: { mode: 'collapsed', forCode: hasCode } });

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
    hasCode,
    dockCollapsed,
    openDock,
    collapseDock,
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
