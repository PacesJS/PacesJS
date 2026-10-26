/** The only way the UI talks to its host (CLI server, VS Code webview, dev server). */

export interface SessionInfo {
  /** Summary of the session meta (command, duration, mode, ...). Shape owned by the host. */
  meta: Record<string, unknown>;
  hasBaseline: boolean;
}

export interface SourceResult {
  exists: boolean;
  text: string;
  hash: string;
  changedSinceProfile: boolean;
}

export type Settings = Record<string, unknown>;

export interface HostAdapter {
  loadSession(): Promise<SessionInfo>;
  /** Binary `serializeModel` bytes. */
  loadModel(which?: 'baseline'): Promise<Uint8Array>;
  readSource(path: string): Promise<SourceResult>;
  /** Browser sessions: the JPEG of one filmstrip frame, by the id the model lists. */
  readScreenshot(id: number): Promise<Uint8Array>;
  openInEditor(file: string, line: number): Promise<void>;
  loadSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
}
