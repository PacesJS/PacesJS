import { classifyNodeFunction } from '../passes/classification.js';
import { NODE_RULES } from '../passes/findings.js';
import { detectNodeTarget } from '../passes/target.js';
import type { RunAdapter } from './types.js';

/** A Node command: its entry script and launchers decide the target; the rules cover the event loop. */
export const NODE_RUN: RunAdapter = {
  detectTarget: detectNodeTarget,
  classifyFunction: classifyNodeFunction,
  rules: NODE_RULES,
};
