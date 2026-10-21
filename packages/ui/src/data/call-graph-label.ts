import { Origin } from '@pacesjs/engine';
import type { FunctionInfo } from '@pacesjs/engine';
import { locationOf } from './scope';

const TEXT = {
  entry: 'entry point',
  package: 'package',
  node: 'node',
  native: 'native',
  v8: 'V8',
} as const;

/** `file:line` of a user or dependency function; runtime, native and collapsed packages have none. */
export function cgLocation(info: FunctionInfo): string {
  if (info.synthetic) return '';
  return info.origin === Origin.User || info.origin === Origin.Dependency ? locationOf(info) : '';
}

/** The small line under a call-graph node's name: where it lives, or what kind of thing it is. */
export function cgSubtitle(info: FunctionInfo, isEntry: boolean, loc: string): string {
  if (isEntry) return TEXT.entry;
  if (info.synthetic) return TEXT.package;
  if (loc) return loc.split('/').pop() ?? loc;
  if (info.origin === Origin.Node) return TEXT.node;
  if (info.origin === Origin.Native) return TEXT.native;
  if (info.origin === Origin.Gc) return TEXT.v8;
  return '';
}
