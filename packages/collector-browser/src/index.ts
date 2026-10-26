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
