import { useMemo, useState } from 'react';
import { useApp } from '../app/context';
import { useAsync, useCanvas, useElementWidth, usePalette } from '../app/hooks';
import { originInfo } from '../theme/origin';
import { fmtDuration, fmtRange, fmtShare } from '../util/format';
import { roundedRectPath } from '../view/draw-shapes';
import { flameFill } from '../view/flame-fill';
import { FLAME, flameHeight, flameRects, hitRect } from '../view/flame-geometry';
import type { FlameRect } from '../view/flame-geometry';
import { Hint } from './Hint';
import { Legend } from './Legend';
import { PopoverSurface } from './Popover';

interface MenuState {
  x: number;
  y: number;
  fn: number;
}

export function FlameGraph() {
  const { client, scope, scopeKey, snap, dispatch, selection, hoverFn, select, state, openDock } =
    useApp();
  const { sort, color, layout, zoom, zoomPath } = snap.options;
  const q = useAsync(
    () => client.flame(scope, { sort, color, zoom, zoomPath }),
    `flame:${scopeKey}:${sort}:${color}:${zoom.join('.')}:${zoomPath.join('.')}`,
  );
  const data = q.data;
  const pal = usePalette();
  const [plotEl, setPlotEl] = useState<HTMLDivElement | null>(null);
  const width = useElementWidth(plotEl);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const search = state.search.trim().toLowerCase();
  const rects = useMemo(
    () =>
      data && width > 0
        ? flameRects(data, width, layout, (i) => ({
            name: data.names[i] ?? '',
            loc: data.locs[i] ?? '',
          }))
        : [],
    [data, width, layout],
  );

  const canvasRef = useCanvas(
    (ctx) => {
      if (!data) return;
      ctx.font = `600 12px ${pal.fontSans}`;
      ctx.textBaseline = 'middle';
      const selFn = selection.fn;
      for (const r of rects) {
        const i = r.index;
        const origin = data.origin[i] ?? 4;
        const isRoot = data.node[i] === -1;
        const dimmed =
          search !== '' && !`${data.names[i]} ${data.locs[i]}`.toLowerCase().includes(search);
        ctx.globalAlpha = dimmed ? 0.25 : 1;
        ctx.fillStyle = flameFill(pal, data, i, color);
        roundedRectPath(ctx, r.x, r.y, r.w, r.h, 4);
        ctx.fill();
        const isSel = selFn !== null && !isRoot && data.fn[i] === selFn;
        const isHover = hoverFn !== null && !isRoot && data.fn[i] === hoverFn;
        if (isSel || isHover) {
          ctx.strokeStyle = pal.outline;
          ctx.lineWidth = isSel ? 2 : 1;
          roundedRectPath(ctx, r.x + 1, r.y + 1, Math.max(1, r.w - 2), r.h - 2, 3);
          ctx.stroke();
        }
        if (r.label) {
          ctx.fillStyle = pal.ink;
          ctx.font = `${origin === 0 && !isRoot ? 600 : 500} 12px ${pal.fontSans}`;
          ctx.fillText(r.label, r.x + 8, r.y + r.h / 2 + 0.5);
        }
        ctx.globalAlpha = 1;
      }
    },
    [data, rects, pal, color, selection.fn, hoverFn, search, width],
  );

  if (q.error)
    return (
      <div className="wf-empty" role="alert">
        {q.error}
      </div>
    );
  if (!data)
    return (
      <div className="wf-empty" role="status">
        Loading flame graph…
      </div>
    );

  const height = flameHeight(data, width);
  const rangeLabel = snap.range ? fmtRange(snap.range[0], snap.range[1]) : null;
  const crumbBase = rangeLabel ? `All samples · ${rangeLabel}` : 'All samples';
  const rootSec = data.rootUs / 1_000_000;
  const half = rootSec >= 10 ? `${(rootSec / 2).toFixed(1)} s` : `${(rootSec / 2).toFixed(2)} s`;

  const pick = (e: React.PointerEvent<HTMLDivElement>): FlameRect | null => {
    const rect = plotEl?.getBoundingClientRect();
    if (!rect) return null;
    return hitRect(rects, e.clientX - rect.left, e.clientY - rect.top);
  };
  const zoomInto = (index: number): void => {
    const node = data.node[index] ?? -1;
    if (node < 0) return;
    dispatch({
      type: 'go',
      patch: { selection: { kind: 'fn', fn: data.fn[index] ?? 0 } },
      options: { zoom: [...zoom, node], zoomPath: [] },
    });
  };

  const hovered = hover ? hover.index : -1;
  const hoveredName = hovered >= 0 ? (data.names[hovered] ?? '') : '';
  const hoverTotal = hovered >= 0 ? (data.totalUs[hovered] ?? 0) : 0;
  const hoverSelf = hovered >= 0 ? (data.selfUs[hovered] ?? 0) : 0;

  const mirror = rects
    .filter((r) => r.w > 40 && data.node[r.index] !== -1)
    .sort((a, b) => b.w - a.w)
    .slice(0, 80);

  return (
    <>
      <div className="toolbar">
        <div className="field">
          <label htmlFor="fg-sort">Sort</label>
          <select
            id="fg-sort"
            className="select"
            value={sort}
            onChange={(e) =>
              dispatch({
                type: 'options',
                options: { sort: e.target.value === 'alpha' ? 'alpha' : 'heavy' },
              })
            }
          >
            <option value="heavy">Left-heavy, by total time</option>
            <option value="alpha">Alphabetical</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="fg-color">Color</label>
          <select
            id="fg-color"
            className="select"
            value={color}
            onChange={(e) =>
              dispatch({
                type: 'options',
                options: { color: e.target.value === 'self' ? 'self' : 'origin' },
              })
            }
          >
            <option value="origin">By origin</option>
            <option value="self">By self time</option>
          </select>
        </div>
        <div className="seg" role="group" aria-label="Layout">
          <button
            type="button"
            aria-pressed={layout === 'icicle'}
            onClick={() => dispatch({ type: 'options', options: { layout: 'icicle' } })}
          >
            Icicle
          </button>
          <button
            type="button"
            aria-pressed={layout === 'flames'}
            onClick={() => dispatch({ type: 'options', options: { layout: 'flames' } })}
          >
            Flames
          </button>
        </div>
        {data.delta ? (
          <ul className="legend" aria-label="Difference colors">
            <li className="legend-item">
              <span
                className="legend-swatch"
                style={{ background: 'var(--c-diff-faster)' }}
                aria-hidden="true"
              />
              Faster than baseline
            </li>
            <li className="legend-item">
              <span
                className="legend-swatch"
                style={{ background: 'var(--c-diff-slower)' }}
                aria-hidden="true"
              />
              Slower than baseline
            </li>
            <li className="legend-item">Intensity = size of the change</li>
          </ul>
        ) : (
          <Legend />
        )}
      </div>
      <Hint id="hint-flame">
        Identical stacks are merged. Width is how long a frame was on the stack; left to right is
        not time. For order, use the Waterfall.
      </Hint>
      <div className="toolbar-row" style={{ gap: 8 }}>
        <nav aria-label="Zoom path" className="flame-crumbs">
          <button
            type="button"
            className="flame-crumb"
            onClick={() => dispatch({ type: 'options', options: { zoom: [], zoomPath: [] } })}
          >
            {crumbBase}
          </button>
          {data.crumbs.map((c, i) => (
            <button
              key={c.node}
              type="button"
              className="flame-crumb"
              onClick={() =>
                dispatch({
                  type: 'options',
                  options: {
                    zoom: data.crumbs.slice(0, i + 1).map((x) => x.node),
                    zoomPath: [],
                  },
                })
              }
            >
              {c.name}
            </button>
          ))}
          {data.crumbs.length === 0 ? (
            <span className="muted">Click a frame to zoom into it</span>
          ) : null}
        </nav>
        <p className="axis-caption">
          width = share of samples · order = {sort === 'alpha' ? 'alphabetical' : 'heaviest first'},
          not time
        </p>
      </div>
      <div className="flame-scroll">
        <div className="flame-inner">
          <div
            ref={setPlotEl}
            className="flame-plot"
            role="img"
            aria-label={`${layout === 'icicle' ? 'Icicle' : 'Flame'} graph of ${data.length} frames. ${data.names[1] ?? ''} is the widest top-level frame.`}
            style={{ height, cursor: hover ? 'pointer' : 'default' }}
            onPointerMove={(e) => {
              const r = pick(e);
              const box = plotEl?.getBoundingClientRect();
              if (r && box) {
                setHover({ index: r.index, x: e.clientX - box.left, y: r.y + FLAME.rowH });
                if (data.node[r.index] !== -1)
                  dispatch({ type: 'hover', selection: { kind: 'fn', fn: data.fn[r.index] ?? 0 } });
              } else {
                setHover(null);
                dispatch({ type: 'hover', selection: { kind: 'none' } });
              }
            }}
            onPointerLeave={() => {
              setHover(null);
              dispatch({ type: 'hover', selection: { kind: 'none' } });
            }}
            onClick={(e) => {
              setMenu(null);
              const r = pick(e as unknown as React.PointerEvent<HTMLDivElement>);
              // A click on a frame is the plot's own (it zooms and selects); empty canvas is not,
              // so it reaches the shell, where click-off clears the selection.
              if (!r) return;
              e.stopPropagation();
              zoomInto(r.index);
            }}
            onDoubleClick={() => openDock()}
            onContextMenu={(e) => {
              const r = pick(e as unknown as React.PointerEvent<HTMLDivElement>);
              if (!r || data.node[r.index] === -1) return;
              e.preventDefault();
              const box = plotEl?.getBoundingClientRect();
              setMenu({
                x: e.clientX - (box?.left ?? 0),
                y: e.clientY - (box?.top ?? 0),
                fn: data.fn[r.index] ?? 0,
              });
            }}
          >
            <canvas ref={canvasRef} className="flame-canvas" aria-hidden="true" />
            <div className="flame-mirror" role="list" aria-label="Frames, widest first">
              {mirror.map((r) => {
                const i = r.index;
                const dd = data.delta ? (data.delta[i] ?? 0) : null;
                const change =
                  dd === null || Math.abs(dd) < 0.05
                    ? ''
                    : dd < 0
                      ? ', faster than baseline'
                      : ', slower than baseline';
                const label = `${data.names[i]}${change}, ${originInfo(data.origin[i] ?? 4).label}, ${fmtDuration(data.totalUs[i] ?? 0)} total, ${fmtShare((data.totalUs[i] ?? 0) / (data.rootUs || 1))} of samples`;
                return (
                  <button
                    key={`${data.node[i]}`}
                    type="button"
                    role="listitem"
                    aria-label={label}
                    style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
                    onFocus={() =>
                      dispatch({ type: 'hover', selection: { kind: 'fn', fn: data.fn[i] ?? 0 } })
                    }
                    onBlur={() => dispatch({ type: 'hover', selection: { kind: 'none' } })}
                    onClick={(e) => {
                      e.stopPropagation();
                      zoomInto(i);
                    }}
                  />
                );
              })}
            </div>
            {hover && hovered >= 0 && data.node[hovered] !== -1 ? (
              <div
                role="tooltip"
                className="tooltip"
                style={{ left: Math.min(hover.x + 8, Math.max(0, width - 300)), top: hover.y }}
              >
                <span className="tooltip-title">
                  {hoveredName}
                  {data.locs[hovered] ? (
                    <span className="muted" style={{ fontWeight: 400 }}>
                      {' '}
                      · {data.locs[hovered]}
                    </span>
                  ) : null}
                </span>
                <span className="num" style={{ fontSize: 12, lineHeight: '16px' }}>
                  Total {fmtDuration(hoverTotal)} · {fmtShare(hoverTotal / (data.rootUs || 1))} of
                  samples · self {fmtDuration(hoverSelf)}
                </span>
                {data.delta ? (
                  <span className="tooltip-sub">
                    {Math.abs(data.delta[hovered] ?? 0) < 0.05
                      ? 'About the same as the baseline'
                      : (data.delta[hovered] ?? 0) < 0
                        ? 'Faster than the baseline'
                        : 'Slower than the baseline'}
                  </span>
                ) : null}
                <span className="tooltip-sub">
                  Double-click for source · right-click for Show in waterfall
                </span>
              </div>
            ) : null}
            {menu ? (
              <PopoverSurface
                id="flame-context-menu"
                role="menu"
                label="Frame actions"
                onClose={() => setMenu(null)}
                style={{ left: menu.x, top: menu.y, minWidth: 200 }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    dispatch({
                      type: 'go',
                      patch: { view: 'waterfall', selection: { kind: 'fn', fn: menu.fn } },
                    });
                    setMenu(null);
                  }}
                >
                  Show in waterfall
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    dispatch({
                      type: 'go',
                      patch: { view: 'functions', selection: { kind: 'fn', fn: menu.fn } },
                    });
                    setMenu(null);
                  }}
                >
                  Show callers
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    dispatch({
                      type: 'go',
                      patch: { view: 'callgraph', selection: { kind: 'fn', fn: menu.fn } },
                    });
                    setMenu(null);
                  }}
                >
                  Show in call graph
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    select({ kind: 'fn', fn: menu.fn });
                    setMenu(null);
                  }}
                >
                  Select
                </button>
              </PopoverSurface>
            ) : null}
          </div>
          <div className="flame-axis" aria-hidden="true">
            <span style={{ left: 0 }}>0%</span>
            <span style={{ left: '25%', transform: 'translateX(-50%)' }}>25%</span>
            <span style={{ left: '50%', transform: 'translateX(-50%)' }}>
              50% of samples ({half})
            </span>
            <span style={{ left: '75%', transform: 'translateX(-50%)' }}>75%</span>
            <span style={{ right: 0 }}>100%</span>
          </div>
        </div>
      </div>
      <p className="view-footer" style={{ display: 'block' }}>
        Dependency, Node and native frames are dimmed, never hidden.{' '}
        {snap.transforms.some((t) => t.k === 'merge-plumbing')
          ? 'Plumbing frames are merged into their callers. '
          : 'Plumbing frames are shown. '}
        Keys: f focus · m merge · c collapse package · i invert.
      </p>
    </>
  );
}
