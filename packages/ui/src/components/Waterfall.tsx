import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../app/context';
import { useBarTooltip } from '../app/useBarTooltip';
import { useTimeWindow } from '../app/useTimeWindow';
import {
  measureText,
  useAsync,
  useCanvas,
  useElementWidth,
  usePalette,
  useStableCallback,
} from '../app/hooks';
import { createHoverStore } from '../app/hover';
import type { WaterfallRow } from '../data/types';
import type { WfColumns } from '../state/prefs';
import { fmtAxis, fmtDuration, fmtShare } from '../util/format';
import { drawBar } from '../view/draw-bars';
import { niceTicks } from '../view/scale';
import { MIN_BAR_PX, fitCallWidth, fitNumericWidth, gridTemplate } from '../view/waterfall-columns';
import type { ColumnKey } from '../view/waterfall-columns';
import { WF, barColumn, barRect, labelFitsBar, visibleSlice } from '../view/waterfall-geometry';
import { foldRows, hotTargetPath, reconcileCollapsed } from '../view/waterfall-fold';
import { rowFacts, selectedRowIdOf } from '../view/waterfall-facts';
import { waterfallKeyAction } from '../view/waterfall-keys';
import { durLabel, tipStyle } from '../view/waterfall-labels';
import { visibleRows } from '../view/waterfall-rows';
import type { Transform } from '../state/types';
import { WaterfallRowView } from './WaterfallRowView';
import { ColumnResizer } from './ColumnResizer';
import { Hint } from './Hint';
import { WaterfallLegend } from './WaterfallLegend';
import { WaterfallToolbar } from './WaterfallToolbar';

const VIEWPORT_H = 720;

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
  const [hover] = useState(createHoverStore);
  const { tip, show: showTip, hide: hideTip } = useBarTooltip();
  const [liveCols, setLiveCols] = useState<WfColumns | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [rowsEl, setRowsEl] = useState<HTMLDivElement | null>(null);
  const width = useElementWidth(rowsEl);
  const pal = usePalette();
  const cols = liveCols ?? state.prefs.wfCols;

  const taskKey = data ? `${data.trackId}:${data.mode}:${data.taskIndex}` : '';
  const [showSmall, setShowSmall] = useState(false);
  const {
    window,
    reset: resetWindow,
    onWheel,
    onPanStart,
  } = useTimeWindow({ taskKey, taskUs: data?.taskUs ?? 1, rowsEl, cols });
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
  const slice = useMemo(() => visible.slice(from, to), [visible, from, to]);

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

  const onToggle = useCallback((id: number): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const selectRow = useStableCallback((r: WaterfallRow): void => {
    if (!data) return;
    if (r.kind === 'fold') {
      onToggle(r.id);
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
  });
  const onOpen = useStableCallback(() => openDock());
  const onFocus = useCallback(
    (transform: Transform): void => dispatch({ type: 'add-transform', transform }),
    [dispatch],
  );
  const onBarEnter = useStableCallback(showTip);
  const onBarLeave = useStableCallback(hideTip);

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
  const mirrorTask = tasksQ.data ?? [];
  const gridStyle = { ['--wf-grid' as string]: gridTemplate(cols) } as CSSProperties;
  const minWidth = WF.pad * 2 + cols.call + MIN_BAR_PX + cols.time + cols.share + WF.gap * 3;

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

  const winStartPct = (window.start / total) * 100;
  const winWidthPct = ((window.end - window.start) / total) * 100;

  return (
    <>
      <WaterfallToolbar
        data={data}
        tasks={mirrorTask}
        showSmall={showSmall}
        onToggleSmall={() => setShowSmall((v) => !v)}
        threshold={threshold}
        foldLabel={foldLabel}
        hiding={hiding}
        hiddenSmall={folded?.hiddenSmall ?? 0}
      />
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
              onDoubleClick={resetWindow}
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
            onPointerDown={onPanStart}
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
                return (
                  <WaterfallRowView
                    key={r.id}
                    r={r}
                    top={(from + k) * WF.rowH}
                    selected={isSel}
                    // The same function elsewhere in the tree gets a faint "linked" mark.
                    linked={
                      !isSel && selection.fn !== null && r.kind === 'call' && r.fn === selection.fn
                    }
                    collapsed={collapsed.has(r.id)}
                    callWidth={cols.call}
                    fontSans={pal.fontSans}
                    functionCount={summary.functionCount}
                    threshold={threshold}
                    foldLabel={foldLabel}
                    whole={data.mode === 'run' ? 'run' : 'task'}
                    winStart={window.start}
                    winEnd={window.end}
                    barX0={bar.x0}
                    barX1={bar.x1}
                    hiddenKids={facts.hidden.get(r.id) ?? 0}
                    cpuUs={facts.cpu.get(r.id) ?? 0}
                    hover={hover}
                    onSelect={selectRow}
                    onToggle={onToggle}
                    onOpen={onOpen}
                    onFocus={onFocus}
                    onBarEnter={onBarEnter}
                    onBarLeave={onBarLeave}
                  />
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
      <WaterfallLegend threshold={threshold} />
      <span className="sr-only" role="status" aria-live="polite">
        {data.taskLabel}, {fmtDuration(data.taskUs)}, {data.rows.length - 1} calls
      </span>
    </>
  );
}
