import type { TaskOption } from '../data/types';

const TEXT = {
  smallTasks: (count: number) => `Small tasks (${count})`,
} as const;

export const TASK_GROUPS = [
  'Whole run',
  'Entry',
  'Requests',
  'Timers',
  'I/O',
  'Microtasks',
  'Other',
  'Small tasks',
] as const;

/** Option value of the picker when a time range is shown instead of a task. */
export const RANGE_OPTION = -2;

export interface PickerGroup {
  group: TaskOption['group'];
  label: string;
  tasks: TaskOption[];
}

/** The task picker's optgroups. Small tasks stay folded away until asked for, unless one of them is open. */
export function taskPickerGroups(
  all: readonly TaskOption[],
  showSmall: boolean,
  openTask: number,
): PickerGroup[] {
  const out: PickerGroup[] = [];
  for (const group of TASK_GROUPS) {
    const inGroup = all.filter((t) => t.group === group);
    const tasks =
      group === 'Small tasks' && !showSmall ? inGroup.filter((t) => t.index === openTask) : inGroup;
    if (tasks.length === 0) continue;
    out.push({
      group,
      label: group === 'Small tasks' ? TEXT.smallTasks(inGroup.length) : group,
      tasks,
    });
  }
  return out;
}
