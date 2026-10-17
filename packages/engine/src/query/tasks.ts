// The task list for the task picker: grouped by what started the work, longest first.

import { TaskKind } from '../model.js';
import type { ExecutionModel } from '../model.js';
import { displayPath } from '../util/paths.js';
import type { TaskDescriptor, TaskGroup } from './types.js';
import { trivialTasks } from './waterfall.js';
import { trackAt } from './track-at.js';

const GROUP_ORDER: TaskGroup[] = [
  'Whole run',
  'Entry',
  'Requests',
  'Timers',
  'I/O',
  'Microtasks',
  'Other',
  'Small tasks',
];

function groupOf(kind: number, isEntry: boolean): TaskGroup {
  if (isEntry) return 'Entry';
  switch (kind) {
    case TaskKind.Request:
      return 'Requests';
    case TaskKind.Timer:
    case TaskKind.Immediate:
      return 'Timers';
    case TaskKind.Io:
      return 'I/O';
    case TaskKind.Microtask:
      return 'Microtasks';
    default:
      return 'Other';
  }
}

export function describeTasks(model: ExecutionModel, trackIndex: number): TaskDescriptor[] {
  const track = trackAt(model, trackIndex);
  const tasks = track.tasks;
  let entryTask = -1;
  for (let k = 0; k < tasks.length && entryTask < 0; k++) {
    if (tasks.kind[k] === TaskKind.Main) entryTask = k;
  }
  const small = trivialTasks(model, trackIndex);
  let longestTask = -1;
  let longestUs = -1;
  const out: TaskDescriptor[] = [];
  for (let k = 0; k < tasks.length; k++) {
    const durationUs = (tasks.end[k] ?? 0) - (tasks.start[k] ?? 0);
    if (durationUs > longestUs) {
      longestUs = durationUs;
      longestTask = k;
    }
    const isEntry = k === entryTask;
    const trivial = small.has(k);
    out.push({
      index: k,
      group: trivial ? 'Small tasks' : groupOf(tasks.kind[k] ?? TaskKind.Other, isEntry),
      label:
        isEntry && track.entry
          ? `main · load ${displayPath(track.entry)}`
          : (model.strings[tasks.label[k] ?? 0] ?? ''),
      startUs: tasks.start[k] ?? 0,
      durationUs,
      busyUs: tasks.busy[k] ?? 0,
      longest: false,
      trivial,
    });
  }
  const longest = out[longestTask];
  if (longest) longest.longest = true;
  const firstStart = tasks.length > 0 ? (tasks.start[0] ?? 0) : 0;
  const lastEnd = tasks.length > 0 ? (tasks.end[tasks.length - 1] ?? 0) : 0;
  out.push({
    index: -1,
    group: 'Whole run',
    label: `Whole run · ${track.entry ? displayPath(track.entry) : '(entry)'}`,
    startUs: firstStart,
    durationUs: lastEnd - firstStart,
    busyUs: track.busyUs,
    longest: false,
    trivial: false,
  });
  return out.sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
      b.durationUs - a.durationUs ||
      a.index - b.index,
  );
}
