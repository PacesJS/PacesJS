import { encodeTransform } from './hash';
import type { Transform } from './types';

/** Names for transform chips. `fnName` resolves function ids to display names. */
export function transformLabel(t: Transform, fnName: (fn: number) => string): string {
  switch (t.k) {
    case 'collapse-deps':
      return 'Collapse dependencies';
    case 'merge-plumbing':
      return 'Merge plumbing';
    case 'drop-idle':
      return 'Drop idle';
    case 'invert':
      return 'Invert';
    case 'collapse-pkg':
      return `Collapse ${t.pkg}`;
    case 'merge-fn':
      return `Merge ${fnName(t.fn)}`;
    case 'merge-node':
      return `Merge node`;
    case 'focus-fn':
      return `Focus on ${fnName(t.fn)}`;
    case 'focus-self':
      return `Focus on ${fnName(t.fn)} self`;
    case 'focus-node':
      return `Focus on subtree`;
    case 'collapse-rec':
      return `Collapse recursion in ${fnName(t.fn)}`;
    case 'drop-fn':
      return `Drop samples with ${fnName(t.fn)}`;
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
