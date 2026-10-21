import { useApp } from '../app/context';
import type { TaskOption, WaterfallData } from '../data/types';
import { Switch } from './Switch';
import { TaskPicker } from './TaskPicker';
import { SORTS, MIN_DURATIONS } from '../view/waterfall-rows';
import type { WaterfallSort } from '../view/waterfall-rows';

const TEXT = {
  criticalPath: 'Critical path',
  pathOnly: 'Path only',
  pathOnlyKey: 'p',
  logicalFlow: 'Logical flow',
  fromAsync: 'from --async',
  needsAsync: 'needs --async',
  hideSmall: 'Hide small tasks',
  showSmall: (count: number) => `Show ${count} small tasks`,
  order: 'Order',
  timeOrder: 'time order',
  minDuration: 'Min duration',
  auto: (threshold: string) => `Auto · hide under ${threshold}`,
  atLeast: (label: string) => `≥ ${label}`,
  hiding: (fold: string, count: number) => `Hiding rows under ${fold} (${count})`,
  show: 'show',
  axis: (order: string) =>
    `x = time inside the task, ms · siblings in ${order} · ~ = sampled estimate`,
} as const;

interface WaterfallToolbarProps {
  data: WaterfallData;
  tasks: readonly TaskOption[];
  showSmall: boolean;
  onToggleSmall(): void;
  /** The precision label, e.g. "2 ms". */
  threshold: string;
  /** What the fold rows call the cut-off. */
  foldLabel: string;
  hiding: boolean;
  /** Rows hidden behind small-row folds. */
  hiddenSmall: number;
}

/** Critical path, path only, logical flow, the task picker, order, minimum duration and the filter summary. */
export function WaterfallToolbar({
  data,
  tasks,
  showSmall,
  onToggleSmall,
  threshold,
  foldLabel,
  hiding,
  hiddenSmall,
}: WaterfallToolbarProps) {
  const { snap, dispatch } = useApp();
  const { wfSort, minDurUs, pathOnly } = snap.options;
  const hasAsync = data.hasAsync;
  const smallCount = tasks.filter((t) => t.group === 'Small tasks').length;
  const order = SORTS.find((s) => s.value === wfSort)?.label.toLowerCase() ?? TEXT.timeOrder;
  return (
    <div className="toolbar-row">
      <div className="toolbar" style={{ gap: 12 }}>
        <Switch
          checked={snap.options.critical}
          onChange={(v) => dispatch({ type: 'options', options: { critical: v } })}
        >
          {TEXT.criticalPath}
        </Switch>
        <Switch
          checked={pathOnly}
          onChange={(v) => dispatch({ type: 'options', options: { pathOnly: v } })}
        >
          {TEXT.pathOnly} <kbd className="kbd">{TEXT.pathOnlyKey}</kbd>
        </Switch>
        <Switch
          checked={snap.options.logical && hasAsync}
          disabled={!hasAsync}
          onChange={(v) => dispatch({ type: 'options', options: { logical: v } })}
          hint={hasAsync ? TEXT.fromAsync : TEXT.needsAsync}
        >
          {TEXT.logicalFlow}
        </Switch>
        <TaskPicker data={data} tasks={tasks} showSmall={showSmall} />
        {smallCount > 0 ? (
          <button
            type="button"
            className="btn btn-sm"
            aria-pressed={showSmall}
            onClick={onToggleSmall}
          >
            {showSmall ? TEXT.hideSmall : TEXT.showSmall(smallCount)}
          </button>
        ) : null}
        <div className="field">
          <label htmlFor="wf-sort">{TEXT.order}</label>
          <select
            id="wf-sort"
            className="select"
            value={wfSort}
            onChange={(e) =>
              dispatch({
                type: 'options',
                options: { wfSort: e.target.value as WaterfallSort },
              })
            }
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="wf-min">{TEXT.minDuration}</label>
          <select
            id="wf-min"
            className="select"
            value={minDurUs}
            onChange={(e) =>
              dispatch({ type: 'options', options: { minDurUs: Number(e.target.value) } })
            }
          >
            <option value={-1}>{TEXT.auto(threshold)}</option>
            {MIN_DURATIONS.map((m) => (
              <option key={m.us} value={m.us}>
                {m.us === 0 ? m.label : TEXT.atLeast(m.label)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {hiding && hiddenSmall > 0 ? (
        <span className="filter-summary" role="status">
          {TEXT.hiding(foldLabel, hiddenSmall)}
          <button
            type="button"
            className="filter-reset"
            onClick={() => dispatch({ type: 'options', options: { minDurUs: 0 } })}
          >
            {TEXT.show}
          </button>
        </span>
      ) : null}
      <p className="axis-caption" style={{ fontWeight: 400 }}>
        {TEXT.axis(order)}
      </p>
    </div>
  );
}
