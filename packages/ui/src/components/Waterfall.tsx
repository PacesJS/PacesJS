import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { useApp } from '../app/context';
import { measureText, useAsync, useCanvas, useElementWidth, usePalette } from '../app/hooks';
import type { WaterfallRow } from '../data/types';
import type { WfColumns } from '../state/prefs';
import { originColor, originInfo } from '../theme/origin';
import { fmtAxis, fmtDuration, fmtShare } from '../util/format';
import { drawBar } from '../view/draw-bars';
import { niceTicks } from '../view/scale';
import {
  MIN_BAR_PX,
  fitCallWidth,
  fitNumericWidth,
  gridTemplate,
  resizeColumn,
} from '../view/waterfall-columns';
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
import { visibleRows } from '../view/waterfall-rows';
import type { WaterfallSort } from '../view/waterfall-rows';
import { Hint } from './Hint';
import { Icon } from './Icon';
import { Legend } from './Legend';
import { Switch } from './Switch';

const VIEWPORT_H = 720;
const KEY_STEP_PX = 8;

const TASK_GROUPS = ['Entry', 'Requests', 'Timers', 'I/O', 'Microtasks', 'Other'] as const;

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

function durLabel(r: WaterfallRow): string {
  if (r.belowPrecision) return '< 2 ms';
  return fmtDuration(r.end - r.start, { decimals: 1 });
}

const ORIGIN_HINT: Record<number, string> = { 1: 'node_modules', 3: 'node', 4: 'native', 6: 'V8' };

function rowLocation(r: WaterfallRow): string {
  if (r.kind === 'task') return 'event-loop task';
  return r.loc || (ORIGIN_HINT[r.origin] ?? '');
}

function samePath(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((f, i) => f === b[i]);
}

interface ResizerProps {
  column: ColumnKey;
  label: string;
  cols: WfColumns;
  /** Which edge of its header cell the handle sits on. */
  edge: 'left' | 'right';
  onLive(cols: WfColumns | null): void;
  onCommit(cols: WfColumns): void;
  onFit(column: ColumnKey): void;
}

/** Drag handle on a header edge: drag to resize, arrows nudge, double-click or Enter auto-fits. */
function ColumnResizer({ column, label, cols, edge, onLive, onCommit, onFit }: ResizerProps) {
  const drag = useRef<{ x: number; cols: WfColumns } | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      aria-valuenow={cols[column]}
      tabIndex={0}
      className={`wf-resizer is-${edge}`}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, cols };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) onLive(resizeColumn(d.cols, column, e.clientX - d.x));
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (d) onCommit(resizeColumn(d.cols, column, e.clientX - d.x));
        onLive(null);
      }}
      onPointerCancel={() => {
        drag.current = null;
        onLive(null);
      }}
      onDoubleClick={() => onFit(column)}
      onKeyDown={(e) => {
        const step =
          e.key === 'ArrowRight' ? KEY_STEP_PX : e.key === 'ArrowLeft' ? -KEY_STEP_PX : 0;
        if (step !== 0) {
          e.preventDefault();
          onCommit(resizeColumn(cols, column, step));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          onFit(column);
        }
      }}
    />
  );
}

export function Waterfall() {
  const { client, scope, scopeKey, snap, state, dispatch, selection, select, summary } = useApp();
  const task = snap.options.task;
  const tasksQ = useAsync(() => client.tasks(scope), `tasks:${scopeKey}`);
  const { wfSort, minDurUs, pathOnly } = snap.options;
  const wfQ = useAsync(
    () => client.waterfall(scope, task, { sort: wfSort, minDurUs }),
    `wf:${scopeKey}:${task}:${wfSort}:${minDurUs}`,
  );
  const data = wfQ.data;

  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const [hoverRow, setHoverRow] = useState<number | null>(null);
  const [liveCols, setLiveCols] = useState<WfColumns | null>(null);
  const [win, setWin] = useState<{ key: string; w: TimeWindow } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [rowsEl, setRowsEl] = useState<HTMLDivElement | null>(null);
  const width = useElementWidth(rowsEl);
  const pal = usePalette();
  const cols = liveCols ?? state.prefs.wfCols;

  const taskKey = data ? `${data.trackId}:${data.taskIndex}` : '';
  const window = win && win.key === taskKey ? win.w : { start: 0, end: data?.taskUs ?? 1 };
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const visible = useMemo(
    () => visibleRows(rows, collapsed, pathOnly && data ? data.criticalRows : null),
    [rows, collapsed, pathOnly, data],
  );
  const [from, to] = visibleSlice(scrollTop, VIEWPORT_H, visible.length);
  const slice = visible.slice(from, to);

  const sel = snap.selection;
  const selectedRowId = useMemo((): number | null => {
    if (!data) return null;
    const hit = (r: WaterfallRow): boolean => {
      if (sel.kind === 'node') return r.kind === 'call' && samePath(sel.path, r.path);
      if (sel.kind === 'task') return r.kind === 'task' && sel.track === data.trackId;
      if (sel.kind === 'fn') return r.kind === 'call' && r.fn === sel.fn;
      return false;
    };
    if (sel.kind === 'node' && sel.row !== undefined) {
      const exact = rows.find((r) => r.id === sel.row);
      if (exact && hit(exact)) return exact.id;
    }
    return rows.find(hit)?.id ?? null;
  }, [data, rows, sel]);

  // A newly selected row opens the collapsed ancestors that hide it (state adjusted during render).
  const [seenRow, setSeenRow] = useState<number | null>(null);
  if (selectedRowId !== seenRow) {
    setSeenRow(selectedRowId);
    if (selectedRowId !== null) {
      const byId = new Map(rows.map((r) => [r.id, r]));
      const hidden: number[] = [];
      for (let p = byId.get(selectedRowId)?.parent ?? -1; p >= 0; p = byId.get(p)?.parent ?? -1) {
        hidden.push(p);
      }
      if (hidden.some((id) => collapsed.has(id))) {
        setCollapsed(new Set([...collapsed].filter((id) => !hidden.includes(id))));
      }
    }
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
        const label = durLabel(r);
        if (ctx.measureText(label).width + 12 > rect.w) return;
        ctx.fillStyle = pal.ink;
        ctx.fillText(label, rect.x + 6, y + WF.barH / 2 + 0.5);
      });
    },
    [data, slice, rows, window, pal, snap.options.critical, width, cols],
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
  const gridStyle = { ['--wf-grid' as string]: gridTemplate(cols) } as CSSProperties;
  const minWidth = WF.pad * 2 + cols.call + MIN_BAR_PX + cols.time + cols.share + WF.gap * 3;

  const selectRow = (r: WaterfallRow): void => {
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
            shown.map((r) => (column === 'time' ? durLabel(r) : fmtShare(r.share))),
            (t) => measureText(t, `600 14px ${pal.fontSans}`),
          );
    dispatch({ type: 'prefs', prefs: { wfCols: { ...state.prefs.wfCols, [column]: next } } });
  };

  const move = (e: KeyboardEvent<HTMLDivElement>): void => {
    const idx = visible.findIndex((ri) => (rows[ri] as WaterfallRow).id === selectedRowId);
    const cur = idx >= 0 ? (rows[visible[idx] as number] as WaterfallRow) : null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next =
        idx < 0
          ? 0
          : Math.max(0, Math.min(visible.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)));
      const r = rows[visible[next] as number];
      if (r) selectRow(r);
    } else if (e.key === 'ArrowLeft' && cur) {
      e.preventDefault();
      if (cur.hasChildren && !collapsed.has(cur.id)) setCollapsed(new Set([...collapsed, cur.id]));
      else {
        for (let k = idx - 1; k >= 0; k--) {
          const pr = rows[visible[k] as number] as WaterfallRow;
          if (pr.depth < cur.depth) {
            selectRow(pr);
            break;
          }
        }
      }
    } else if (e.key === 'ArrowRight' && cur) {
      e.preventDefault();
      if (collapsed.has(cur.id)) {
        const n = new Set(collapsed);
        n.delete(cur.id);
        setCollapsed(n);
      } else {
        const nxt = rows[visible[idx + 1] as number];
        if (nxt && nxt.depth > cur.depth) selectRow(nxt);
      }
    } else if (e.key === 'Enter' && cur) {
      e.preventDefault();
      dispatch({ type: 'set-source-collapsed', collapsed: false });
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      dispatch({ type: 'back' });
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const rect = rowsEl?.getBoundingClientRect();
    if (!rect) return;
    const col = barColumn(rect.width, cols);
    const anchor = Math.min(1, Math.max(0, (e.clientX - rect.left - col.x0) / (col.x1 - col.x0)));
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
              value={data.taskIndex}
              onChange={(e) =>
                dispatch({
                  type: 'go',
                  patch: {
                    selection: { kind: 'task', track: data.trackId, task: Number(e.target.value) },
                  },
                  options: { task: Number(e.target.value) },
                })
              }
            >
              {TASK_GROUPS.map((group) => {
                const tasks = mirrorTask.filter((t) => t.group === group);
                return tasks.length === 0 ? null : (
                  <optgroup key={group} label={group}>
                    {tasks.map((t) => (
                      <option key={t.index} value={t.index}>
                        {group === 'Entry' ? `${t.label} · program entry point` : t.label} ·{' '}
                        {fmtDuration(t.durationUs)}
                        {t.longest ? ' · longest' : ''}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </div>
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
              {MIN_DURATIONS.map((m) => (
                <option key={m.us} value={m.us}>
                  {m.us === 0 ? m.label : `≥ ${m.label}`}
                </option>
              ))}
            </select>
          </div>
        </div>
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
            <div className="wf-minimap" aria-hidden="true" onDoubleClick={() => setWin(null)}>
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
            <div className="caps wf-col-right wf-head-cell">
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
                return (
                  <div
                    key={r.id}
                    role="row"
                    aria-level={r.depth + 1}
                    aria-expanded={r.hasChildren ? !collapsed.has(r.id) : undefined}
                    aria-selected={isSel}
                    aria-label={`${r.name}, ${info.label}, ${durLabel(r)}, ${fmtShare(r.share)} of ${r.kind === 'task' ? 'itself' : 'task'}${r.critical ? ', critical path' : ''}`}
                    className={`wf-row${isSel ? ' is-selected' : ''}${hoverRow === r.id ? ' is-hover' : ''}${isLinked ? ' is-linked' : ''}`}
                    style={{ top: (from + k) * WF.rowH }}
                    onClick={() => selectRow(r)}
                    onDoubleClick={() =>
                      dispatch({ type: 'set-source-collapsed', collapsed: false })
                    }
                    onPointerEnter={() => setHoverRow(r.id)}
                    onPointerLeave={() => setHoverRow(null)}
                  >
                    <div
                      className="wf-name"
                      role="cell"
                      title={where ? `${r.name}  ${where}` : r.name}
                      style={{ paddingLeft: r.depth * 16 }}
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
                      <span className={`wf-label${isUser ? ' is-user' : ''}`}>{r.name}</span>
                      <span className="wf-loc">{where}</span>
                    </div>
                    <div className="wf-bar-cell" role="cell" aria-hidden="true" />
                    <div className="wf-time" role="cell">
                      {durLabel(r)}
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

      <div className="view-footer">
        <Legend label="Origin colors" />
        <span className="wf-legend-item">
          <span className="wf-legend-swatch swatch-critical" aria-hidden="true" />
          Critical path: widest child at each level
        </span>
        <span className="wf-legend-item">
          <span className="wf-legend-swatch swatch-hatch" aria-hidden="true" />
          Under {fmtDuration(2 * summary.intervalUs, { approx: false, decimals: 0 })}, below
          sampling precision
        </span>
        <span className="wf-legend-item">
          <span className="wf-legend-swatch swatch-wait" aria-hidden="true" />
          Idle wait between an await and its continuation
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
