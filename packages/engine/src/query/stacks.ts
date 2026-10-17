// Transform stacks shared by the agent-facing queries (hot paths, call trees).

import { Origin } from '../model.js';
import type { OriginId } from '../model.js';
import type { Transform } from './types.js';

const ALL_ORIGINS: OriginId[] = [
  Origin.User,
  Origin.Dependency,
  Origin.Framework,
  Origin.Node,
  Origin.Native,
  Origin.Idle,
  Origin.Gc,
];

/** What an agent-facing query always applies first: stitch continuations, merge plumbing, drop idle. */
export const SHOWN_PREFIX: readonly Transform[] = [
  { kind: 'stitch-continuations' },
  { kind: 'merge-plumbing' },
  { kind: 'drop-idle' },
];

/** The transform that hides every origin except `keep`, or undefined when nothing would be hidden. */
export function hideAllExcept(keep: readonly number[]): Transform | undefined {
  const origins = ALL_ORIGINS.filter((o) => !keep.includes(o));
  return origins.length > 0 ? { kind: 'hide-origins', origins } : undefined;
}
