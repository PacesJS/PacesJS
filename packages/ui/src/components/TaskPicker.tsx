import { useApp } from '../app/context';
import type { TaskOption, WaterfallData } from '../data/types';
import { fmtDuration } from '../util/format';
import { RANGE_OPTION, taskPickerGroups } from '../view/waterfall-picker';

const TEXT = {
  task: 'Task',
  entryPoint: (label: string) => `${label} · program entry point`,
  duration: (dur: string) => ` · ${dur}`,
  longest: ' · longest',
} as const;

/** The waterfall's Task select: the whole run, the entry point, then tasks grouped by what started them. */
export function TaskPicker({
  data,
  tasks,
  showSmall,
}: {
  data: WaterfallData;
  tasks: readonly TaskOption[];
  showSmall: boolean;
}) {
  const { dispatch } = useApp();
  return (
    <div className="field">
      <label htmlFor="task-pick">{TEXT.task}</label>
      <select
        id="task-pick"
        className="select"
        value={data.mode === 'range' ? RANGE_OPTION : data.taskIndex}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (v === RANGE_OPTION) return;
          dispatch(
            v < 0
              ? {
                  type: 'go',
                  patch: { selection: { kind: 'none' }, range: null },
                  options: { task: -1 },
                }
              : {
                  type: 'go',
                  patch: { selection: { kind: 'task', track: data.trackId, task: v } },
                  options: { task: v },
                },
          );
        }}
      >
        {data.mode === 'range' ? <option value={RANGE_OPTION}>{data.taskLabel}</option> : null}
        {taskPickerGroups(tasks, showSmall, data.taskIndex).map((g) => (
          <optgroup key={g.group} label={g.label}>
            {g.tasks.map((t) => (
              <option key={t.index} value={t.index}>
                {g.group === 'Entry' ? TEXT.entryPoint(t.label) : t.label}
                {g.group === 'Whole run' ? '' : TEXT.duration(fmtDuration(t.durationUs))}
                {t.longest ? TEXT.longest : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
