import { classifyBrowserFunction } from '../passes/classification.js';
import { BROWSER_RULES } from '../passes/findings-browser.js';
import { gcPressure, hotFunction, hotPath } from '../passes/findings.js';
import { detectBrowserTarget } from '../passes/target.js';
import type { RunAdapter } from './types.js';

/**
 * A web page: the launched site (and the site serving its app) is the target. A page has no event
 * loop, synchronous I/O or module loading, so it has its own rules beside the ones that still apply.
 */
export const BROWSER_RUN: RunAdapter = {
  fixedRunKind: 'page',
  detectTarget: detectBrowserTarget,
  classifyFunction: classifyBrowserFunction,
  rules: [...BROWSER_RULES, hotFunction, hotPath, gcPressure],
};
