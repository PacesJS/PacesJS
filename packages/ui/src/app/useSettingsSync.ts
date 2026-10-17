import { useEffect, useRef } from 'react';
import type { HostAdapter } from '../host/adapter';
import type { Prefs } from '../state/prefs';
import type { AppState } from '../state/reducer';

/** Persist dismissed hints, pinned tracks and layout preferences through the host when they change. */
export function useSettingsSync(
  host: HostAdapter,
  state: AppState,
  initial: { dismissed: string[]; pinned: string[]; prefs: Prefs },
): void {
  const savedRef = useRef(
    JSON.stringify({ d: initial.dismissed, p: initial.pinned, u: initial.prefs }),
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
}
