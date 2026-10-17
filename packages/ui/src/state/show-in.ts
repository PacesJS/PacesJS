import type { AppAction } from './reducer';
import type { ViewId } from './types';

/** Open `view` with the function selected ("Show in waterfall", "Show callers", ...). */
export function showInView(view: ViewId, fn: number): Extract<AppAction, { type: 'go' }> {
  return { type: 'go', patch: { view, selection: { kind: 'fn', fn } } };
}
