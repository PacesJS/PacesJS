import { encodeTransform } from './hash';
import type { Transform } from './types';

const TEXT = {
  stitch: 'Stitch continuations (inferred)',
  collapseDeps: 'Collapse dependencies',
  mergePlumbing: 'Merge plumbing',
  dropIdle: 'Drop idle',
  invert: 'Invert',
  collapsePkg: (pkg: string) => `Collapse ${pkg}`,
  merge: (name: string) => `Merge ${name}`,
  mergeNode: 'Merge node',
  focusOn: (name: string) => `Focus on ${name}`,
  focusSelf: (name: string) => `Focus on ${name} self`,
  focusSubtree: 'Focus on subtree',
  collapseRec: (name: string) => `Collapse recursion in ${name}`,
  dropSamples: (name: string) => `Drop samples with ${name}`,
} as const;

/** Names for transform chips. `fnName` resolves function ids to display names. */
export function transformLabel(t: Transform, fnName: (fn: number) => string): string {
  switch (t.k) {
    case 'stitch':
      return TEXT.stitch;
    case 'collapse-deps':
      return TEXT.collapseDeps;
    case 'merge-plumbing':
      return TEXT.mergePlumbing;
    case 'drop-idle':
      return TEXT.dropIdle;
    case 'invert':
      return TEXT.invert;
    case 'collapse-pkg':
      return TEXT.collapsePkg(t.pkg);
    case 'merge-fn':
      return TEXT.merge(fnName(t.fn));
    case 'merge-node':
      return TEXT.mergeNode;
    case 'focus-fn':
      return TEXT.focusOn(fnName(t.fn));
    case 'focus-self':
      return TEXT.focusSelf(fnName(t.fn));
    case 'focus-node':
      return TEXT.focusSubtree;
    case 'collapse-rec':
      return TEXT.collapseRec(fnName(t.fn));
    case 'drop-fn':
      return TEXT.dropSamples(fnName(t.fn));
  }
}

const same = (a: Transform, b: Transform): boolean => encodeTransform(a) === encodeTransform(b);

/** Append unless the same transform is already on the stack. Invert toggles. */
export function addTransform(stack: readonly Transform[], t: Transform): Transform[] {
  if (t.k === 'invert' && stack.some((x) => x.k === 'invert')) return removeKind(stack, 'invert');
  if (stack.some((x) => same(x, t))) return stack.slice();
  return [...stack, t];
}

export function removeTransform(stack: readonly Transform[], index: number): Transform[] {
  return stack.filter((_, i) => i !== index);
}

function removeKind(stack: readonly Transform[], k: Transform['k']): Transform[] {
  return stack.filter((x) => x.k !== k);
}

/** Clicking a chip rewinds to that point: later transforms are dropped. */
export function rewindTo(stack: readonly Transform[], index: number): Transform[] {
  return stack.slice(0, index + 1);
}

export const hasTransform = (stack: readonly Transform[], k: Transform['k']): boolean =>
  stack.some((x) => x.k === k);
