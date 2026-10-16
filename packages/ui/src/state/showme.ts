import type { ShowMe } from '@pacesjs/engine';
import type { AppAction } from './reducer';
import { addTransform, removeTransform } from './transforms';
import type { Selection, Snapshot, TimeRange, ViewId } from './types';

const VIEW_OF: Record<ShowMe['view'], ViewId | null> = {
  waterfall: 'waterfall',
  flame: 'flame',
  callgraph: 'callgraph',
  functions: 'functions',
  timeline: null,
};

/** Turn a finding's `showMe` target into one history step: view, selection, range and options. */
export function showMeAction(showMe: ShowMe, current: Snapshot, defaultTrack: string): AppAction {
  const view = VIEW_OF[showMe.view] ?? current.view;
  const track = showMe.track ?? defaultTrack;
  let selection: Selection = current.selection;
  // A function is the more specific target: the task still opens in the waterfall through options.task.
  if (showMe.fn !== undefined) selection = { kind: 'fn', fn: showMe.fn };
  else if (showMe.task !== undefined) selection = { kind: 'task', track, task: showMe.task };
  const range: TimeRange | null = showMe.range ? [showMe.range[0], showMe.range[1]] : current.range;
  let transforms = current.transforms;
  const opts = showMe.options ?? {};
  const unmerge =
    opts['unmergePlumbing'] === true ||
    opts['plumbing'] === false ||
    opts['mergePlumbing'] === false;
  if (unmerge) {
    const i = transforms.findIndex((t) => t.k === 'merge-plumbing');
    if (i >= 0) transforms = removeTransform(transforms, i);
  }
  const pkg = opts['package'] ?? opts['expandPackage'];
  const expanded =
    typeof pkg === 'string'
      ? [...new Set([...current.options.expanded, pkg])]
      : current.options.expanded;
  if (typeof pkg === 'string' && view === 'callgraph')
    transforms = addTransform(transforms, { k: 'collapse-deps' });
  return {
    type: 'go',
    patch: {
      view,
      selection,
      range,
      transforms,
    },
    options: {
      ...(typeof opts['criticalPath'] === 'boolean' ? { critical: opts['criticalPath'] } : {}),
      ...(typeof opts['critical'] === 'boolean' ? { critical: opts['critical'] } : {}),
      ...(showMe.task !== undefined ? { task: showMe.task } : {}),
      ...(showMe.line !== undefined ? { line: showMe.line } : {}),
      expanded,
      zoom: [],
    },
  };
}
