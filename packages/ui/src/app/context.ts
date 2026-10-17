import { createContext, useContext } from 'react';
import type { Dispatch } from 'react';
import type { HostAdapter } from '../host/adapter';
import type { QueryClient } from '../data/protocol';
import type { ModelSummary, Scope, SelectionInfo } from '../data/queries';
import type { AppAction, AppState } from '../state/reducer';
import type { Selection, Snapshot } from '../state/types';

export interface AppContextValue {
  host: HostAdapter;
  client: QueryClient;
  summary: ModelSummary;
  state: AppState;
  snap: Snapshot;
  dispatch: Dispatch<AppAction>;
  /** Scope for aggregate queries: track, transform stack, range. */
  scope: Scope;
  /** Stable string identifying the scope, for query keys. */
  scopeKey: string;
  /** What the current selection resolves to (function, track, task). */
  selection: SelectionInfo;
  /** The track whose tasks and spans the waterfall shows. */
  primaryTrack: string;
  select(selection: Selection): void;
  /** The selection has source to show: a function or a call, not a task, range or package. */
  hasCode: boolean;
  /** The dock is a slim rail (it follows the selection, unless the user chose). */
  dockCollapsed: boolean;
  /** Reveal the source dock now; it follows the selection again once that next changes. */
  openDock(): void;
  collapseDock(): void;
  /** Search box text, shared with the functions table. */
  search: string;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppContext.Provider>.');
  return ctx;
}
