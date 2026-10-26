import type { BrowserTimeline } from '@pacesjs/engine';
import { useApp } from './context';
import { useAsync } from './hooks';

/** The filmstrip, milestones, rendering and input of a browser run; null for a Node run or while loading. */
export function useBrowserData(): BrowserTimeline | null {
  const { client } = useApp();
  return useAsync(() => client.browser(), 'browser').data ?? null;
}
