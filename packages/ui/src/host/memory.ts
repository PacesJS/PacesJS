import type { HostAdapter, SessionInfo, Settings, SourceResult } from './adapter';

export interface MemoryHostInit {
  model: Uint8Array;
  baseline?: Uint8Array;
  meta?: Record<string, unknown>;
  sources?: Record<string, Partial<SourceResult> & { text: string }>;
  settings?: Settings;
}

/** In-memory adapter for tests and the dev server. */
export function memoryHostAdapter(
  init: MemoryHostInit,
): HostAdapter & { opened: Array<[string, number]> } {
  let settings: Settings = { ...init.settings };
  const opened: Array<[string, number]> = [];
  return {
    opened,
    loadSession: async (): Promise<SessionInfo> => ({
      meta: init.meta ?? {},
      hasBaseline: init.baseline !== undefined,
    }),
    loadModel: async (which) => {
      const bytes = which === 'baseline' ? init.baseline : init.model;
      if (!bytes) throw new Error('paces host: no baseline model in this session');
      return bytes;
    },
    readSource: async (path): Promise<SourceResult> => {
      const hit = init.sources?.[path];
      if (!hit) return { exists: false, text: '', hash: '', changedSinceProfile: false };
      return { exists: true, hash: '', changedSinceProfile: false, ...hit };
    },
    openInEditor: async (file, line) => {
      opened.push([file, line]);
    },
    loadSettings: async () => settings,
    saveSettings: async (s) => {
      settings = { ...s };
    },
  };
}
