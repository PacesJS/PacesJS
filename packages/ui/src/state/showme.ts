import type { Finding, ShowMe } from '@pacesjs/engine';
import type { AppAction } from './reducer';
import { addTransform, removeTransform } from './transforms';
import type { Selection, Snapshot, TimeRange, ViewId } from './types';

/**
 * One contract for every "Show me":
 *  1. switch to the view that proves the finding;
 *  2. select its target (function, call, task, range or package) and options that show it;
 *  3. announce "Showing: ..." (see `showingText`);
 *  4. be clearable: the same button again, Escape, or the "Clear selection" chip undo it.
 * `isShowing` derives the active finding from the screen state alone, so it survives reloads
 * and history steps.
 */

export interface ShowMeContext {
  /** `model.functions.length`: collapsed packages are numbered from here, by sorted name. */
  functionCount: number;
  packages: readonly string[];
}

export const showMeContext = (s: { functionCount: number; packages: string[] }): ShowMeContext => ({
  functionCount: s.functionCount,
  packages: s.packages,
});

/** `zoomPath: '3,17,42'`: function ids of a call chain to zoom the flame graph to. */
function zoomPathOf(showMe: ShowMe): number[] {
  const raw = str(showMe.options?.['zoomPath']);
  if (!raw) return [];
  const ids = raw.split(',').map((n) => Number(n));
  return ids.every((n) => Number.isInteger(n) && n >= 0) ? ids : [];
}

const NO_CONTEXT: ShowMeContext = { functionCount: 0, packages: [] };

const VIEW_OF: Record<ShowMe['view'], ViewId | null> = {
  waterfall: 'waterfall',
  flame: 'flame',
  callgraph: 'callgraph',
  functions: 'functions',
  timeline: null,
};

const str = (v: string | number | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

function packageOf(showMe: ShowMe): string | undefined {
  const o = showMe.options ?? {};
  return str(o['expandPackage']) ?? str(o['package']);
}

function packageFn(showMe: ShowMe, ctx: ShowMeContext): number | undefined {
  const name = packageOf(showMe);
  if (name === undefined) return undefined;
  const i = ctx.packages.indexOf(name);
  return i < 0 ? undefined : ctx.functionCount + i;
}

function unmerges(showMe: ShowMe): boolean {
  const o = showMe.options ?? {};
  return o['unmergePlumbing'] === true || o['plumbing'] === false || o['mergePlumbing'] === false;
}

/** The view a target proves itself in; timeline targets open the view that reads their range. */
function viewFor(showMe: ShowMe, current: ViewId): ViewId {
  const direct = VIEW_OF[showMe.view];
  if (direct) return direct;
  const o = showMe.options ?? {};
  if (o['delayLane'] === true) return 'waterfall';
  if (o['gcMarkers'] === true) return 'flame';
  return current;
}

/** Turn a finding's `showMe` target into one history step: view, selection, range and options. */
export function showMeAction(
  showMe: ShowMe,
  current: Snapshot,
  defaultTrack: string,
  ctx: ShowMeContext = NO_CONTEXT,
): AppAction {
  const view = viewFor(showMe, current.view);
  const track = showMe.track ?? defaultTrack;
  const pkgFn = packageFn(showMe, ctx);
  // The hash keeps whole microseconds, so the range is rounded here and survives a reload as is.
  const range: TimeRange | null = showMe.range
    ? [Math.round(showMe.range[0]), Math.round(showMe.range[1])]
    : current.range;
  let selection: Selection = current.selection;
  // A function is the more specific target: the task still opens in the waterfall through options.task.
  if (pkgFn !== undefined) selection = { kind: 'fn', fn: pkgFn };
  else if (showMe.fn !== undefined) selection = { kind: 'fn', fn: showMe.fn };
  else if (showMe.task !== undefined) selection = { kind: 'task', track, task: showMe.task };
  else if (showMe.range) selection = { kind: 'range', from: range?.[0] ?? 0, to: range?.[1] ?? 0 };

  let transforms = current.transforms;
  const opts = showMe.options ?? {};
  if (unmerges(showMe)) {
    const i = transforms.findIndex((t) => t.k === 'merge-plumbing');
    if (i >= 0) transforms = removeTransform(transforms, i);
  }
  if (pkgFn !== undefined) transforms = addTransform(transforms, { k: 'collapse-deps' });
  const search = str(opts['search']);
  return {
    type: 'go',
    patch: {
      view,
      selection,
      range,
      transforms,
      track: showMe.track ?? current.track,
    },
    ...(search !== undefined ? { search } : {}),
    options: {
      ...(typeof opts['criticalPath'] === 'boolean' ? { critical: opts['criticalPath'] } : {}),
      ...(typeof opts['critical'] === 'boolean' ? { critical: opts['critical'] } : {}),
      ...(showMe.task !== undefined ? { task: showMe.task } : {}),
      // A range target opens the waterfall on that range, not on a previously picked task.
      ...(showMe.range && showMe.task === undefined ? { task: -1 } : {}),
      // The source panel selects the function's definition; a hot line is only a gutter bar.
      line: 0,
      ...(pkgFn !== undefined ? { reveal: [pkgFn] } : {}),
      zoom: [],
      zoomPath: zoomPathOf(showMe),
    },
  };
}

const sameRange = (a: TimeRange | null, b: readonly [number, number] | undefined): boolean =>
  a !== null && b !== undefined && a[0] === Math.round(b[0]) && a[1] === Math.round(b[1]);

/** Whether the screen currently shows this finding's target. */
export function isShowing(
  finding: Finding,
  snap: Snapshot,
  search: string,
  ctx: ShowMeContext = NO_CONTEXT,
): boolean {
  const s = finding.showMe;
  if (s.track !== undefined && s.track !== snap.track) return false;
  const sel = snap.selection;
  const pkgFn = packageFn(s, ctx);
  if (pkgFn !== undefined) return sel.kind === 'fn' && sel.fn === pkgFn;
  if (s.fn !== undefined) return sel.kind === 'fn' && sel.fn === s.fn;
  if (s.task !== undefined) return sel.kind === 'task' && sel.task === s.task;
  if (s.range) return sameRange(snap.range, s.range);
  if (unmerges(s)) {
    return snap.view === 'flame' && !snap.transforms.some((t) => t.k === 'merge-plumbing');
  }
  const wanted = str(s.options?.['search']);
  if (wanted !== undefined) return snap.view === s.view && search === wanted;
  return false;
}

/** Undo `showMeAction`: drop the selection or range, restore plumbing, clear the search. */
export function clearShowMeAction(finding: Finding, snap: Snapshot): AppAction {
  const s = finding.showMe;
  const transforms =
    unmerges(s) && !snap.transforms.some((t) => t.k === 'merge-plumbing')
      ? addTransform(snap.transforms, { k: 'merge-plumbing' })
      : snap.transforms;
  return {
    type: 'go',
    patch: {
      selection: { kind: 'none' },
      range: s.range ? null : snap.range,
      transforms,
    },
    ...(str(s.options?.['search']) !== undefined ? { search: '' } : {}),
    options: { reveal: [] },
  };
}

/** The "Showing: ..." line for the status region. `target` is the selected thing's name, if any. */
export function showingText(finding: Finding, target: string): string {
  return `Showing: ${finding.title}${target ? ` · ${target}` : ''}`;
}

/** Escape and the "Clear selection" chip: no selection, no range, nothing revealed. */
export const CLEAR_SELECTION: AppAction = {
  type: 'go',
  patch: { selection: { kind: 'none' }, range: null },
  options: { reveal: [] },
};

export const hasSelection = (snap: Snapshot): boolean =>
  snap.selection.kind !== 'none' || snap.range !== null;
