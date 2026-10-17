import { describe, expect, it } from 'vitest';
import type { TaskOption } from '../../src/data/types';
import { taskPickerGroups } from '../../src/view/waterfall-picker';

const task = (index: number, group: TaskOption['group']): TaskOption =>
  ({ index, group, label: `t${index}` }) as TaskOption;

const all = [
  task(-1, 'Whole run'),
  task(0, 'Entry'),
  task(1, 'Timers'),
  task(2, 'Small tasks'),
  task(3, 'Small tasks'),
];

describe('taskPickerGroups', () => {
  it('lists groups in the fixed order and skips empty ones', () => {
    expect(taskPickerGroups(all, true, -1).map((g) => g.group)).toEqual([
      'Whole run',
      'Entry',
      'Timers',
      'Small tasks',
    ]);
  });

  it('folds small tasks away but keeps the open one, and counts them all in the label', () => {
    const hidden = taskPickerGroups(all, false, 3).find((g) => g.group === 'Small tasks');
    expect(hidden?.label).toBe('Small tasks (2)');
    expect(hidden?.tasks.map((t) => t.index)).toEqual([3]);
    expect(taskPickerGroups(all, false, 1).some((g) => g.group === 'Small tasks')).toBe(false);
  });
});
