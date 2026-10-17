import { createContext, useContext, useSyncExternalStore } from 'react';

/**
 * The function under the pointer, for cross-view highlighting. It lives outside the app state so a
 * hover step re-renders only what shows it, not every view.
 */
export interface HoverStore {
  get(): number | null;
  set(fn: number | null): void;
  subscribe(listener: () => void): () => void;
}

export function createHoverStore(): HoverStore {
  let current: number | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(fn) {
      if (fn === current) return;
      current = fn;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const HoverContext = createContext<HoverStore | null>(null);

const NO_HOVER: HoverStore = { get: () => null, set: () => undefined, subscribe: () => () => {} };

/** The hovered function id, or null. Re-renders the caller on every change. */
export function useHoverFn(): number | null {
  const store = useContext(HoverContext) ?? NO_HOVER;
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Whether `fn` is the hovered function. Re-renders the caller only when that answer changes. */
export function useIsHovered(fn: number): boolean {
  const store = useContext(HoverContext) ?? NO_HOVER;
  return useSyncExternalStore(
    store.subscribe,
    () => store.get() === fn,
    () => false,
  );
}
