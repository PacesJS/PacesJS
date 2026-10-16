import { useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useApp } from '../app/context';
import { useAsync, useCanvas, useElementWidth, usePalette } from '../app/hooks';
import { visibleRows } from '../data/waterfall';
import type { WaterfallRow } from '../data/waterfall';
import { originColor, originInfo } from '../theme/origin';
import { fmtAxis, fmtDuration, fmtShare } from '../util/format';
import { drawBar } from '../view/draw-bars';
import { niceTicks } from '../view/scale';
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
import { Hint } from './Hint';
import { Icon } from './Icon';
import { Legend } from './Legend';
import { Switch } from './Switch';

const VIEWPORT_H = 720;

function durLabel(r: WaterfallRow): string {
  if (r.belowPrecision) return '< 2 ms';
  return fmtDuration(r.end - r.start, { decimals: 1 });
}

const ORIGIN_HINT: Record<number, string> = { 1: 'node_modules', 3: 'node', 4: 'native', 6: 'V8' };

function rowLocation(r: WaterfallRow): string {
  if (r.folded > 0 && !r.loc) return `${r.folded + 1} frames folded`;
  return r.loc || (ORIGIN_HINT[r.origin] ?? '');
}

export function Waterfall() {
  const { client, scope, scopeKey, snap, dispatch, selection, hoverFn, select, summary } = useApp();
  const task = snap.options.task;
  const tasksQ = useAsync(() => client.tasks(scope), `tasks:${scopeKey}`);
  const wfQ = useAsync(() => client.waterfall(scope, task), `wf:${scopeKey}:${task}`);
  const data = wfQ.data;

  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const [win, setWin] = useState<{ key: string; w: TimeWindow } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [rowsEl, setRowsEl] = useState<HTMLDivElement | null>(null);
  const width = useElementWidth(rowsEl);
  const pal = usePalette();

  const taskKey = data ? `${data.trackId}:${data.taskIndex}` : '';
  const window = win && win.key === taskKey ? win.w : { start: 0, end: data?.taskUs ?? 1 };
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const visible = useMemo(() => visibleRows(rows, collapsed), [rows, collapsed]);
  const [from, to] = visibleSlice(scrollTop, VIEWPORT_H, visible.length);
  const slice = visible.slice(from, to);

  const canvasRef = useCanvas(
    (ctx, { width: w }) => {
      if (!data) return;
      const col = barColumn(w);
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
        if (!r.belowPrecision && labelFitsBar(rect.w, col.x1 - col.x0)) {
          ctx.fillStyle = pal.ink;
          ctx.fillText(durLabel(r), rect.x + 6, y + WF.barH / 2 + 0.5);
        }
      });
    },
    [data, slice, rows, window, pal, snap.options.critical, width],
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
  const step = niceTicks(window.start / 1000, window.end / 1000, 8);
  const gridSize =
    step.length > 1
      ? ((((step[1] ?? 0) - (step[0] ?? 0)) * 1000) / (window.end - window.start)) * 100
      : 12.5;
  const hasAsync = data.hasAsync;
  const mirrorTask = tasksQ.data ?? [];
  const sel = snap.selection;
  const selectedRowSpan = sel.kind === 'span' ? sel.span : null;

  const selectRow = (r: WaterfallRow): void =>
    select({ kind: 'span', track: data.trackId, span: r.span });

  const move = (e: KeyboardEvent<HTMLDivElement>): void => {
    const idx = visible.findIndex((ri) => (rows[ri] as WaterfallRow).span === selectedRowSpan);
    const cur = idx >= 0 ? (rows[visible[idx] as number] as WaterfallRow) : null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next =
        idx < 0
          ? 0
          : Math.max(0, Math.min(visible.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)));
      const r = rows[visible[next] as number];
      if (r) {
        selectRow(r);
        bodyRef.current?.scrollTo({ top: Math.max(0, next * WF.rowH - 3 * WF.rowH) });
      }
    } else if (e.key === 'ArrowLeft' && cur) {
      e.preventDefault();
      const ri = visible[idx] as number;
      if (cur.hasChildren && !collapsed.has(ri)) setCollapsed(new Set([...collapsed, ri]));
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
      const ri = visible[idx] as number;
      if (collapsed.has(ri)) {
        const n = new Set(collapsed);
        n.delete(ri);
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
    const col = barColumn(rect.width);
    const anchor = Math.min(1, Math.max(0, (e.clientX - rect.left - col.x0) / (col.x1 - col.x0)));
    setWin({ key: taskKey, w: zoomWindow(window, total, anchor, e.deltaY > 0 ? 1.25 : 0.8) });
  };

  const winStartPct = (window.start / total) * 100;
  const winWidthPct = ((window.end - window.start) / total) * 100;

  return (
    <>
      <div className="toolbar-row">
        <div className="toolbar" style={{ gap: 12 }}>
          <Switch
            checked={snap.options.critical}
            onChange={(v) => dispatch({ type: 'options', options: { critical: v } })}
          >
            Critical path <kbd className="kbd">p</kbd>
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
              {mirrorTask.map((t) => (
                <option key={t.index} value={t.index}>
                  {t.label} · {fmtDuration(t.durationUs)}
                  {t.longest ? ' · longest' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="axis-caption" style={{ fontWeight: 400 }}>
          x = time inside the task, ms · rows in execution order · ~ = sampled estimate
        </p>
      </div>
      <Hint id="hint-waterfall">
        Each row is one call, in the order it ran. The bar shows when it started and how long it
        took inside this task. Ctrl + wheel zooms the time axis.
      </Hint>

      <div className="wf-scroll">
        <div className="wf">
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
            <div className="caps">Call</div>
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
            <div className="caps wf-col-right">Time</div>
            <div className="caps wf-col-right">Share</div>
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
              const col = barColumn(rect.width);
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
                const isSel =
                  sel.kind === 'span'
                    ? sel.span === r.span
                    : selection.fn !== null && selection.fn === r.fn;
                const isHover = hoverFn !== null && hoverFn === r.fn;
                const info = originInfo(r.origin);
                const isUser = r.origin === 0;
                return (
                  <div
                    key={r.span}
                    role="row"
                    aria-level={r.depth + 1}
                    aria-expanded={r.hasChildren ? !collapsed.has(ri) : undefined}
                    aria-selected={isSel}
                    aria-label={`${r.name}, ${info.label}, ${durLabel(r)}, ${fmtShare(r.share)} of task${r.critical ? ', critical path' : ''}`}
                    className={`wf-row${isSel ? ' is-selected' : ''}${isHover ? ' is-hover' : ''}`}
                    style={{
                      position: 'absolute',
                      top: (from + k) * WF.rowH,
                      left: 0,
                      right: 0,
                      ['--wf-grid-size' as string]: `${gridSize}%`,
                    }}
                    onClick={() => selectRow(r)}
                    onDoubleClick={() =>
                      dispatch({ type: 'set-source-collapsed', collapsed: false })
                    }
                    onPointerEnter={() =>
                      dispatch({ type: 'hover', selection: { kind: 'fn', fn: r.fn } })
                    }
                    onPointerLeave={() => dispatch({ type: 'hover', selection: { kind: 'none' } })}
                  >
                    <div className="wf-name" role="cell" style={{ paddingLeft: r.depth * 16 }}>
                      {r.hasChildren ? (
                        <span
                          className="wf-twisty"
                          aria-hidden="true"
                          onClick={(e) => {
                            e.stopPropagation();
                            const n = new Set(collapsed);
                            if (n.has(ri)) n.delete(ri);
                            else n.add(ri);
                            setCollapsed(n);
                          }}
                          style={{ transform: collapsed.has(ri) ? 'rotate(-90deg)' : undefined }}
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
                      <span className="wf-loc">{rowLocation(r)}</span>
                    </div>
                    <div
                      className="wf-bar-cell"
                      role="cell"
                      aria-hidden="true"
                      style={{ marginLeft: 0 }}
                    />
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
        {data.taskLabel}, {fmtDuration(data.taskUs)}, {rows.length} calls
      </span>
    </>
  );
}
