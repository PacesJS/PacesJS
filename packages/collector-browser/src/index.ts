export { connectCdp, discoverBrowserSocket } from './attach.js';
export type { AttachedCdp } from './attach.js';
export { connectWebSocket } from './ws-client.js';
export type { WsConnection } from './ws-client.js';
export { createCdpClient } from './cdp-pipe.js';
export type { CdpClient, CdpClientOptions, CdpEvent } from './cdp-pipe.js';
export {
  detectDefaultBrowser,
  parseDesktopExec,
  parseLaunchServicesHandlers,
  parseRegistryValue,
} from './default-browser.js';
export type { DefaultBrowser, DetectDeps } from './default-browser.js';
export { browserArgs, launchBrowser } from './launch.js';
export type { LaunchedBrowser, LaunchOptions } from './launch.js';
export { createSessionController } from './session-controller.js';
export type {
  ControllerOptions,
  ControllerState,
  Phase,
  RecordedMark,
  Recording,
  Segment,
  SessionController,
} from './session-controller.js';
export { BrowserNotSupportedError, isChromiumProduct, startRecording } from './recorder.js';
export type { BrowserRecording, BrowserRun, EndedBy, RecordOptions } from './recorder.js';
export { INSTRUMENTATION_URL, buildInjectedSource } from './inject/entry.js';
export { DEFAULT_SOURCE_LIMITS } from './sources.js';
export type { CollectedSource, SourceWarning } from './sources.js';
export type { ScriptRecord } from './targets.js';
export {
  EXCLUDED_CATEGORIES,
  TRACE_NOISE_NAMES,
  createTraceFilter,
  scrubUrl,
} from './trace-filter.js';
export type { TraceEvent, TraceFilterStats } from './trace.js';
export type { ScreenshotFrame, ScreenshotResult } from './screenshot-store.js';
export { createTargetManager } from './targets.js';
export type { TargetManager, TargetManagerDeps } from './targets.js';
