import type { RawCapture } from '../raw.js';
import { BROWSER_RUN } from './browser.js';
import { NODE_RUN } from './node.js';
import type { RunAdapter } from './types.js';

export { BROWSER_RUN, NODE_RUN };
export type { RunAdapter } from './types.js';

/** The adapter for what was captured; every pass after this one asks it, never the capture. */
export function adapterFor(capture: RawCapture): RunAdapter {
  return capture.browser ? BROWSER_RUN : NODE_RUN;
}
