import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { HostAdapter } from '../host/adapter';
import type { QueryClient } from '../data/protocol';
import type { ModelSummary, Scope, SelectionInfo } from '../data/queries';
import { EMPTY_SELECTION } from '../data/types';
import { Header } from '../components/Header';
import { dockCollapsed as dockIsCollapsed } from '../state/prefs';
import { fmtRange } from '../util/format';
import { Overview } from '../components/Overview';
import { ShortcutSheet } from '../components/ShortcutSheet';
import { Workspace } from '../components/Workspace';
import { stepBrowser } from '../state/browser-history';
import { snapshotToHash } from '../state/hash';
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
import { ALL_TRACKS } from '../state/types';
import type { Selection, Snapshot } from '../state/types';
import { AppContext } from './context';
import type { AppContextValue } from './context';
import { useAsync } from './hooks';
import { useClickOff } from './useClickOff';
import { useGlobalKeys } from './useGlobalKeys';
import { useSettingsSync } from './useSettingsSync';
import { useUrlSync } from './useUrlSync';

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

  const hash = snapshotToHash(snap);
  useUrlSync(state, hash, stateRef, rawDispatch);

  useSettingsSync(host, state, {
    dismissed: initialDismissed,
    pinned: initialPinned,
    prefs: initialPrefs,
  });

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

  useClickOff(clearCurrent);

  useGlobalKeys({
    client,
    dispatch,
    clearCurrent,
    stateRef,
    selectionRef,
    summaryRef,
    searchRef,
  });

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
