import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { focusTransform } from '../state/focus';
import { useApp } from '../app/context';
import { measureText, useAsync, useCanvas, useElementWidth, usePalette } from '../app/hooks';
import type { WaterfallRow } from '../data/types';
import type { WfColumns } from '../state/prefs';
import { originColor, originInfo } from '../theme/origin';
import { fmtAxis, fmtDuration, fmtShare } from '../util/format';
import { drawBar } from '../view/draw-bars';
import { clamp, niceTicks } from '../view/scale';
import { MIN_BAR_PX, fitCallWidth, fitNumericWidth, gridTemplate } from '../view/waterfall-columns';
import type { ColumnKey } from '../view/waterfall-columns';
import {
  WF,
  barColumn,
  barRect,
  labelFitsBar,
  panWindow,
  visibleSlice,
  zoomWindow,
} from '../view/waterfall-geometry';
import type { TimeWindow } from '../view/waterfall-geometry';
import { foldRows, hotTargetPath, reconcileCollapsed } from '../view/waterfall-fold';
import {
  BADGE_DEPTH,
  FOCUS_DEPTH,
  guideLevels,
  indentFor,
  middleEllipsis,
} from '../view/waterfall-indent';
import { rowFacts, selectedRowIdOf } from '../view/waterfall-facts';
import { waterfallKeyAction } from '../view/waterfall-keys';
import { barDetails, durLabel, rowLocation, tipStyle } from '../view/waterfall-labels';
import { visibleRows } from '../view/waterfall-rows';
import type { WaterfallSort } from '../view/waterfall-rows';
import { ColumnResizer } from './ColumnResizer';
import { Hint } from './Hint';
import { Icon } from './Icon';
import { Legend } from './Legend';
import { Switch } from './Switch';

const VIEWPORT_H = 720;

const TASK_GROUPS = [
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
const RANGE_OPTION = -2;

const RESUMED_TIP =
  'Continuations after an await are attached to the call that started them (inferred; run with --async for exact).';

const SORTS: Array<{ value: WaterfallSort; label: string }> = [
  { value: 'time', label: 'Time order' },
  { value: 'duration', label: 'Duration' },
  { value: 'share', label: 'Share' },
];

const MIN_DURATIONS: Array<{ us: number; label: string }> = [
  { us: 0, label: 'Any' },
  { us: 1000, label: '1 ms' },
  { us: 5000, label: '5 ms' },
  { us: 20_000, label: '20 ms' },
];

const TIP_DELAY_MS = 150;

export function Waterfall() {
  const { client, scope, scopeKey, snap, state, dispatch, selection, select, summary, openDock } =
    useApp();
  const task = snap.options.task;
  const tasksQ = useAsync(() => client.tasks(scope), `tasks:${scopeKey}`);
  const { wfSort, minDurUs, pathOnly } = snap.options;
  const wfQ = useAsync(
    // The engine keeps every row; the Min duration picker folds them here, so a row whose callees
    // are all too short still has its chevron and a summary row to open.
    () => client.waterfall(scope, task, { sort: wfSort, minDurUs: -1 }),
    `wf:${scopeKey}:${task}:${wfSort}`,
  );
  const data = wfQ.data;

  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const [hoverRow, setHoverRow] = useState<number | null>(null);
  // The bar tooltip waits a moment so passing over bars does not flicker.
  const [tip, setTip] = useState<{ text: string; x: number; y: number; top: number } | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTip = (): void => {
    if (tipTimer.current !== null) globalThis.clearTimeout(tipTimer.current);
    tipTimer.current = null;
    setTip(null);
  };
  const [liveCols, setLiveCols] = useState<WfColumns | null>(null);
  const [win, setWin] = useState<{ key: string; w: TimeWindow } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [rowsEl, setRowsEl] = useState<HTMLDivElement | null>(null);
  const width = useElementWidth(rowsEl);
  const pal = usePalette();
  const cols = liveCols ?? state.prefs.wfCols;

  const taskKey = data ? `${data.trackId}:${data.mode}:${data.taskIndex}` : '';
  const [showSmall, setShowSmall] = useState(false);
  const window = win && win.key === taskKey ? win.w : { start: 0, end: data?.taskUs ?? 1 };
  const evidence = useMemo(
    () => new Set(summary.findings.flatMap((f) => f.evidence)),
    [summary.findings],
  );
  const auto = minDurUs < 0;
  const threshold = fmtDuration(2 * summary.precisionUs, { approx: false, decimals: 1 });
  // What the fold rows call the cut-off: the precision, or the picked minimum duration.
  const foldLabel = auto ? threshold : fmtDuration(minDurUs, { approx: false, decimals: 0 });
  const hiding = auto || minDurUs > 0;
  // Presentation folds (tiny rows, Node bootstrap) over the engine's rows; nothing is dropped.
  const folded = useMemo(
    () =>
      data
        ? foldRows(data.rows, {
            hideSmall: hiding,
            bootstrap: hiding && data.mode === 'run',
            ...(auto ? {} : { minUs: minDurUs }),
            threshold: foldLabel,
            keep: new Set(),
          })
        : null,
    [data, auto, hiding, minDurUs, foldLabel],
  );
  const rows = useMemo(() => folded?.rows ?? [], [folded]);
  const facts = useMemo(() => rowFacts(rows), [rows]);

  const visible = useMemo(
    () => visibleRows(rows, collapsed, pathOnly && data ? data.criticalRows : null),
    [rows, collapsed, pathOnly, data],
  );
  const [from, to] = visibleSlice(scrollTop, VIEWPORT_H, visible.length);
  const slice = visible.slice(from, to);

  const sel = snap.selection;
  const selectedRowId = useMemo(
    () => (data ? selectedRowIdOf(rows, sel, data.trackId) : null),
    [data, rows, sel],
  );

  // Each new result opens along the chain to the target's hottest function and closes the rest;
  // a selected row keeps its ancestors open. A newly selected row opens the ancestors that hide
  // it. (State is adjusted while rendering.)
  const [seenData, setSeenData] = useState<typeof folded>(null);
  const [seenRow, setSeenRow] = useState<number | null>(null);
  if ((data && folded && folded !== seenData) || selectedRowId !== seenRow) {
    const next = reconcileCollapsed({
      rows,
      folded,
      fresh: folded !== seenData && Boolean(data && folded),
      criticalRows: data?.criticalRows ?? [],
      evidence,
      selectedRowId,
      collapsed,
    });
    if (next) setCollapsed(next);
    setSeenData(folded);
    setSeenRow(selectedRowId);
  }

  // Scroll the selected row into view when the selection changes.
  useEffect(() => {
    if (selectedRowId === null) return;
    const at = visible.findIndex((i) => rows[i]?.id === selectedRowId);
    const box = bodyRef.current;
    if (at < 0 || !box) return;
    const top = at * WF.rowH;
    if (top < box.scrollTop || top + WF.rowH > box.scrollTop + box.clientHeight) {
      box.scrollTo({ top: Math.max(0, top - 3 * WF.rowH) });
    }
    // Only a change of selection moves the scroll position, not collapsing or sorting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRowId, data]);

  // The first screen of a fresh result starts at the hot chain, not at the top of a long run.
  const focusId = useMemo(() => {
    const path = hotTargetPath(rows);
    return path ? (path[1] ?? path[0] ?? null) : null;
  }, [rows]);
  useEffect(() => {
    if (!data || selectedRowId !== null || focusId === null) return;
    const at = visible.findIndex((i) => rows[i]?.id === focusId);
    const box = bodyRef.current;
    if (at > 2 && box) box.scrollTo({ top: (at - 2) * WF.rowH });
    // Only a new result moves the first screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const canvasRef = useCanvas(
    (ctx, { width: w }) => {
      if (!data) return;
      const col = barColumn(w, cols);
      ctx.font = `600 11px ${pal.fontSans}`;
      ctx.textBaseline = 'middle';
      slice.forEach((ri, k) => {
        const r = rows[ri] as WaterfallRow;
        const rect = barRect(r.start, r.end, window, col.x0, col.x1);
        if (rect.hidden) return;
        const y = k * WF.rowH + WF.barTop;
        drawBar(ctx, pal, rect.x, y, rect.w, WF.barH, {
          origin: r.origin,
          hatched: r.belowPrecision,
          critical: snap.options.critical && r.critical,
        });
        if (r.belowPrecision || !labelFitsBar(rect.w, col.x1 - col.x0)) return;
        // Only label a bar the text fits inside, never one it would spill out of.
        if (r.kind === 'fold' && r.fold === 'small') return;
        const label = durLabel(r, threshold);
        if (ctx.measureText(label).width + 12 > rect.w) return;
        ctx.fillStyle = pal.ink;
        ctx.fillText(label, rect.x + 6, y + WF.barH / 2 + 0.5);
      });
    },
    [data, slice, rows, window, pal, snap.options.critical, width, cols, threshold],
  );

  // Minimap bars (whole task) with the visible window outlined.
  const miniRef = useCanvas(
    (ctx, { width: w, height: h }) => {
      if (!data) return;
      for (const r of rows) {
        const left = (r.start / data.taskUs) * w;
        const bw = Math.max(2, ((r.end - r.start) / data.taskUs) * w);
        ctx.fillStyle = pal.originSolid[r.origin] ?? pal.accent;
        ctx.fillRect(left, Math.min(h - 3, 3 + r.depth * 4), bw, 3);
      }
    },
    [data, rows, pal],
  );

  if (wfQ.error)
    return (
      <div className="wf-empty" role="alert">
        {wfQ.error}
      </div>
    );
  if (!data) {
    return (
      <div className="wf-empty" role="status">
        {wfQ.loading ? 'Loading waterfall…' : 'No tasks were recorded on this track.'}
      </div>
    );
  }

  const total = data.taskUs;
  const bar = barColumn(width || 1000, cols);
  // Fewer ticks when the bar column is narrow, so the axis labels never run into each other.
  const tickTarget = Math.max(2, Math.min(8, Math.floor((bar.x1 - bar.x0) / 72)));
  const step = niceTicks(window.start / 1000, window.end / 1000, tickTarget);
  const gridSize =
    step.length > 1
      ? ((((step[1] ?? 0) - (step[0] ?? 0)) * 1000) / (window.end - window.start)) * 100
      : 12.5;
  const hasAsync = data.hasAsync;
  const mirrorTask = tasksQ.data ?? [];
  const smallCount = mirrorTask.filter((t) => t.group === 'Small tasks').length;
  const gridStyle = { ['--wf-grid' as string]: gridTemplate(cols) } as CSSProperties;
  const minWidth = WF.pad * 2 + cols.call + MIN_BAR_PX + cols.time + cols.share + WF.gap * 3;

  const toggleFold = (id: number): void => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
  };

  const selectRow = (r: WaterfallRow): void => {
    if (r.kind === 'fold') {
      toggleFold(r.id);
      return;
    }
    if (r.kind === 'summary' && r.summaryTasks[0] !== undefined) {
      // A row standing for small tasks opens the first of them.
      dispatch({
        type: 'go',
        patch: { selection: { kind: 'task', track: data.trackId, task: r.summaryTasks[0] } },
        options: { task: r.summaryTasks[0] },
      });
      return;
    }
    if (r.kind === 'call') select({ kind: 'node', track: data.trackId, path: r.path, row: r.id });
    else if (r.kind === 'task' && data.taskIndex >= 0)
      select({ kind: 'task', track: data.trackId, task: data.taskIndex });
  };

  const fit = (column: ColumnKey): void => {
    const shown = visible.map((i) => rows[i] as WaterfallRow);
    const nameFont = `500 14px ${pal.fontSans}`;
    const locFont = `400 12px ${pal.fontSans}`;
    const next =
      column === 'call'
        ? fitCallWidth(
            shown,
            (t) => measureText(t, nameFont),
            (t) => measureText(t, locFont),
          )
        : fitNumericWidth(
            column,
            shown.map((r) => (column === 'time' ? durLabel(r, threshold) : fmtShare(r.share))),
            (t) => measureText(t, `600 14px ${pal.fontSans}`),
          );
    dispatch({ type: 'prefs', prefs: { wfCols: { ...state.prefs.wfCols, [column]: next } } });
  };

  const move = (e: KeyboardEvent<HTMLDivElement>): void => {
    const action = waterfallKeyAction(e.key, { visible, rows, collapsed, selectedRowId });
    if (!action) return;
    e.preventDefault();
    if (action.type === 'select') selectRow(action.row);
    else if (action.type === 'collapse') setCollapsed(action.collapsed);
    else if (action.type === 'open-dock') openDock();
    else if (action.type === 'back') dispatch({ type: 'back' });
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const rect = rowsEl?.getBoundingClientRect();
    if (!rect) return;
    const col = barColumn(rect.width, cols);
    const anchor = clamp((e.clientX - rect.left - col.x0) / (col.x1 - col.x0), 0, 1);
    setWin({ key: taskKey, w: zoomWindow(window, total, anchor, e.deltaY > 0 ? 1.25 : 0.8) });
  };

  const winStartPct = (window.start / total) * 100;
  const winWidthPct = ((window.end - window.start) / total) * 100;
  const order = SORTS.find((s) => s.value === wfSort)?.label.toLowerCase() ?? 'time order';

  return (
    <>
      <div className="toolbar-row">
        <div className="toolbar" style={{ gap: 12 }}>
          <Switch
            checked={snap.options.critical}
            onChange={(v) => dispatch({ type: 'options', options: { critical: v } })}
          >
            Critical path
          </Switch>
          <Switch
            checked={pathOnly}
            onChange={(v) => dispatch({ type: 'options', options: { pathOnly: v } })}
          >
            Path only <kbd className="kbd">p</kbd>
          </Switch>
          <Switch
            checked={snap.options.logical && hasAsync}
            disabled={!hasAsync}
            onChange={(v) => dispatch({ type: 'options', options: { logical: v } })}
            hint={hasAsync ? 'from --async' : 'needs --async'}
          >
            Logical flow
          </Switch>
          <div className="field">
            <label htmlFor="task-pick">Task</label>
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
              {data.mode === 'range' ? (
                <option value={RANGE_OPTION}>{data.taskLabel}</option>
              ) : null}
              {TASK_GROUPS.map((group) => {
                const all = mirrorTask.filter((t) => t.group === group);
                // Small tasks stay folded away until asked for, unless one of them is open.
                const tasks =
                  group === 'Small tasks' && !showSmall
                    ? all.filter((t) => t.index === data.taskIndex)
                    : all;
                return tasks.length === 0 ? null : (
                  <optgroup
                    key={group}
                    label={group === 'Small tasks' ? `Small tasks (${all.length})` : group}
                  >
                    {tasks.map((t) => (
                      <option key={t.index} value={t.index}>
                        {group === 'Entry' ? `${t.label} · program entry point` : t.label}
                        {group === 'Whole run' ? '' : ` · ${fmtDuration(t.durationUs)}`}
                        {t.longest ? ' · longest' : ''}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </div>
          {smallCount > 0 ? (
            <button
              type="button"
              className="btn btn-sm"
              aria-pressed={showSmall}
              onClick={() => setShowSmall((v) => !v)}
            >
              {showSmall ? 'Hide small tasks' : `Show ${smallCount} small tasks`}
            </button>
          ) : null}
          <div className="field">
            <label htmlFor="wf-sort">Order</label>
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
            <label htmlFor="wf-min">Min duration</label>
            <select
              id="wf-min"
              className="select"
              value={minDurUs}
              onChange={(e) =>
                dispatch({ type: 'options', options: { minDurUs: Number(e.target.value) } })
              }
            >
              <option value={-1}>Auto · hide under {threshold}</option>
              {MIN_DURATIONS.map((m) => (
                <option key={m.us} value={m.us}>
                  {m.us === 0 ? m.label : `≥ ${m.label}`}
                </option>
              ))}
            </select>
          </div>
        </div>
        {hiding && folded && folded.hiddenSmall > 0 ? (
          <span className="filter-summary" role="status">
            Hiding rows under {foldLabel} ({folded.hiddenSmall})
            <button
              type="button"
              className="filter-reset"
              onClick={() => dispatch({ type: 'options', options: { minDurUs: 0 } })}
            >
              show
            </button>
          </span>
        ) : null}
        <p className="axis-caption" style={{ fontWeight: 400 }}>
          x = time inside the task, ms · siblings in {order} · ~ = sampled estimate
        </p>
      </div>
      <Hint id="hint-waterfall">
        Each row is one call. The bar shows when it started and how long it took inside this task.
        Ctrl + wheel zooms the time axis; drag the column edges to resize them.
      </Hint>

      <div className="wf-scroll">
        <div className="wf" style={{ ...gridStyle, minWidth }}>
          <div className="wf-grid" style={{ paddingTop: 0 }}>
            <div className="caps">Minimap</div>
            <div
              className="wf-minimap"
              data-keeps-selection
              aria-hidden="true"
              onDoubleClick={() => setWin(null)}
            >
              <canvas ref={miniRef} />
              <div
                className="wf-minimap-window"
                style={{ left: `${winStartPct}%`, width: `${winWidthPct}%`, right: 'auto' }}
              />
            </div>
            <div />
            <div />
          </div>
          <div className="wf-grid wf-head">
            <div className="caps wf-head-cell">
              Call
              <ColumnResizer
                column="call"
                label="Call"
                cols={cols}
                edge="right"
                onLive={setLiveCols}
                onCommit={(c) => dispatch({ type: 'prefs', prefs: { wfCols: c } })}
                onFit={fit}
              />
            </div>
            <div className="wf-axis">
              {step.map((t, i) => (
                <span
                  key={t}
                  className="wf-axis-tick"
                  style={{
                    left: `${(((t * 1000 - window.start) / (window.end - window.start)) * 100).toFixed(2)}%`,
                  }}
                >
                  {fmtAxis(t * 1000, 'ms', i === 0)}
                </span>
              ))}
            </div>
            <div
              className="caps wf-col-right wf-head-cell"
              title="Elapsed time of the call (includes awaiting)"
            >
              <ColumnResizer
                column="time"
                label="Time"
                cols={cols}
                edge="left"
                onLive={setLiveCols}
                onCommit={(c) => dispatch({ type: 'prefs', prefs: { wfCols: c } })}
                onFit={fit}
              />
              Time
            </div>
            <div className="caps wf-col-right wf-head-cell">
              <ColumnResizer
                column="share"
                label="Share"
                cols={cols}
                edge="left"
                onLive={setLiveCols}
                onCommit={(c) => dispatch({ type: 'prefs', prefs: { wfCols: c } })}
                onFit={fit}
              />
              Share
            </div>
          </div>
          <div
            ref={bodyRef}
            className="wf-body"
            tabIndex={0}
            role="table"
            aria-label="Waterfall rows"
            aria-rowcount={rows.length}
            style={{ ['--wf-grid-size' as string]: `${gridSize}%` }}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            onKeyDown={move}
            onWheel={onWheel}
            onPointerDown={(e) => {
              if (e.button !== 0 || !e.shiftKey) return;
              const start = e.clientX;
              const w0 = window;
              const rect = rowsEl?.getBoundingClientRect();
              if (!rect) return;
              const col = barColumn(rect.width, cols);
              const usPerPx = (w0.end - w0.start) / (col.x1 - col.x0);
              const onMove = (ev: PointerEvent): void =>
                setWin({ key: taskKey, w: panWindow(w0, total, -(ev.clientX - start) * usPerPx) });
              const onUp = (): void => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
              };
              document.addEventListener('pointermove', onMove);
              document.addEventListener('pointerup', onUp);
            }}
          >
            <div ref={setRowsEl} className="wf-rows" style={{ height: visible.length * WF.rowH }}>
              <canvas
                ref={canvasRef}
                className="wf-canvas"
                aria-hidden="true"
                style={{ top: from * WF.rowH, height: Math.max(1, slice.length * WF.rowH) }}
              />
              {slice.map((ri, k) => {
                const r = rows[ri] as WaterfallRow;
                const isSel = r.id === selectedRowId;
                // Hover lights only the row under the pointer; the same function elsewhere in
                // the tree gets a faint "linked" mark when it is the selected function.
                const isLinked =
                  !isSel && selection.fn !== null && r.kind === 'call' && r.fn === selection.fn;
                const info = originInfo(r.origin);
                const isUser = r.origin === 0;
                const where = rowLocation(r);
                const indent = indentFor(r.depth, cols.call);
                const badged = r.kind === 'call' && r.depth > BADGE_DEPTH;
                const depthBadge = `⋯ ${r.depth}`;
                const focusAs =
                  r.kind === 'call' && r.depth > FOCUS_DEPTH
                    ? focusTransform(r.path, r.fn, summary.functionCount)
                    : null;
                const nameFont = `${isUser ? 600 : 500} 14px ${pal.fontSans}`;
                const room =
                  cols.call -
                  indent -
                  (14 + 8 + 12) -
                  (focusAs
                    ? 44 + 6
                    : badged
                      ? measureText(depthBadge, `600 11px ${pal.fontSans}`) + 8 + 6
                      : 0) -
                  (r.resumed ? 22 : 0) -
                  2;
                const label = middleEllipsis(r.name, Math.max(room, 24), (t) =>
                  measureText(t, nameFont),
                );
                const hiddenKids = facts.hidden.get(r.id) ?? 0;
                const hiddenNote =
                  hiddenKids > 0
                    ? `${hiddenKids} ${hiddenKids === 1 ? 'callee' : 'callees'} under ${foldLabel} hidden`
                    : '';
                const nameTitle = [
                  r.name,
                  where,
                  r.depth > BADGE_DEPTH ? `level ${r.depth + 1}` : '',
                  hiddenNote,
                ]
                  .filter(Boolean)
                  .join(' · ');
                const details = barDetails(r, threshold, data.mode === 'run' ? 'run' : 'task', {
                  cpuUs: facts.cpu.get(r.id) ?? 0,
                });
                const rect = barRect(r.start, r.end, window, bar.x0, bar.x1);
                const barBox = details && !rect.hidden ? rect : null;
                return (
                  <div
                    key={r.id}
                    role="row"
                    aria-level={r.depth + 1}
                    aria-expanded={r.hasChildren ? !collapsed.has(r.id) : undefined}
                    aria-selected={isSel}
                    aria-description={
                      [details, hiddenNote].filter(Boolean).join(' · ') || undefined
                    }
                    aria-label={`${r.name}, ${info.label}, ${durLabel(r, threshold)}, ${fmtShare(r.share)} of ${r.kind === 'task' ? 'itself' : 'task'}${r.critical ? ', critical path' : ''}`}
                    className={`wf-row${isSel ? ' is-selected' : ''}${hoverRow === r.id ? ' is-hover' : ''}${isLinked ? ' is-linked' : ''}`}
                    style={{ top: (from + k) * WF.rowH }}
                    onClick={() => selectRow(r)}
                    onDoubleClick={() => openDock()}
                    onPointerEnter={() => setHoverRow(r.id)}
                    onPointerLeave={() => setHoverRow(null)}
                  >
                    <div
                      className="wf-name"
                      role="cell"
                      title={nameTitle}
                      style={{
                        paddingLeft: indent,
                        ['--wf-guides' as string]: guideLevels(r.depth),
                      }}
                    >
                      {r.hasChildren ? (
                        <span
                          className="wf-twisty"
                          aria-hidden="true"
                          onClick={(e) => {
                            e.stopPropagation();
                            const n = new Set(collapsed);
                            if (n.has(r.id)) n.delete(r.id);
                            else n.add(r.id);
                            setCollapsed(n);
                          }}
                          style={{ transform: collapsed.has(r.id) ? 'rotate(-90deg)' : undefined }}
                        >
                          <Icon name="chevron-down" size={14} strokeWidth={2} />
                        </span>
                      ) : (
                        <span style={{ width: 14, flex: 'none' }} />
                      )}
                      <span
                        className="wf-dot"
                        aria-hidden="true"
                        style={{ background: originColor(r.origin, false) }}
                      />
                      {focusAs ? (
                        <button
                          type="button"
                          className="wf-depth is-action"
                          aria-label={`Focus here: ${r.name}`}
                          title={`Level ${r.depth + 1}. Focus here: make this call the root of the waterfall (f)`}
                          onClick={(e) => {
                            e.stopPropagation();
                            dispatch({ type: 'add-transform', transform: focusAs });
                          }}
                        >
                          {hoverRow === r.id || isSel ? 'Focus' : depthBadge}
                        </button>
                      ) : badged ? (
                        <span
                          className="wf-depth"
                          aria-hidden="true"
                          title={`Level ${r.depth + 1}`}
                        >
                          {depthBadge}
                        </span>
                      ) : null}
                      <span
                        className={`wf-label${isUser ? ' is-user' : ''}${r.kind === 'wait' || r.kind === 'fold' ? ' is-wait' : ''}`}
                      >
                        {label}
                      </span>
                      {r.resumed ? (
                        <span className="wf-resumed" title={RESUMED_TIP}>
                          <span aria-hidden="true">↻</span>
                          <span className="sr-only">resumed after an await, inferred</span>
                        </span>
                      ) : null}
                      <span className="wf-loc">{where}</span>
                    </div>
                    <div className="wf-bar-cell" role="cell" aria-hidden="true" />
                    {barBox ? (
                      <div
                        className="wf-bar-hit"
                        aria-hidden="true"
                        style={{ left: barBox.x, width: barBox.w, top: WF.barTop, height: WF.barH }}
                        onPointerEnter={(e) => {
                          const el = e.currentTarget;
                          hideTip();
                          tipTimer.current = globalThis.setTimeout(() => {
                            const b = el.getBoundingClientRect();
                            setTip({
                              text: details,
                              x: b.left + b.width / 2,
                              y: b.bottom,
                              top: b.top,
                            });
                          }, TIP_DELAY_MS);
                        }}
                        onPointerLeave={hideTip}
                      />
                    ) : null}
                    <div className="wf-time" role="cell">
                      {durLabel(r, threshold)}
                    </div>
                    <div className="wf-share" role="cell">
                      {fmtShare(r.share)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {tip
        ? createPortal(
            <div
              role="tooltip"
              className="tooltip"
              style={tipStyle(tip, globalThis.innerWidth, globalThis.innerHeight)}
            >
              <span className="tooltip-title">{tip.text}</span>
            </div>,
            document.body,
          )
        : null}
      <div className="view-footer">
        <Legend label="Origin colors" />
        <span className="wf-legend-item">
          <span className="wf-legend-swatch swatch-critical" aria-hidden="true" />
          Critical path: widest child at each level
        </span>
        <span className="wf-legend-item">
          <span className="wf-legend-swatch swatch-hatch" aria-hidden="true" />
          Under {threshold}, below sampling precision
        </span>
        <span className="wf-legend-item">
          <span className="wf-legend-swatch swatch-wait" aria-hidden="true" />
          Idle wait between an await and its continuation
        </span>
        <span className="wf-legend-item" title={RESUMED_TIP}>
          <span aria-hidden="true" className="wf-resumed">
            ↻
          </span>
          Resumed after an await: attached to the call that started it (inferred; run with --async
          for exact)
        </span>
        <span className="wf-legend-item">
          <span className="wf-depth" aria-hidden="true">
            ⋯ N
          </span>
          Depth of a deep call. Past level 12 it is a button: Focus here (or f) makes the call the
          root
        </span>
        <span className="view-footer-end">
          Arrows walk rows · Enter opens source · f focus · Backspace back
        </span>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {data.taskLabel}, {fmtDuration(data.taskUs)}, {data.rows.length - 1} calls
      </span>
    </>
  );
}
