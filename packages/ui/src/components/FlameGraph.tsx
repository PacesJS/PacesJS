import { useMemo, useState } from 'react';
import { useApp } from '../app/context';
import { useHoverFn } from '../app/hover';
import { useAsync, useCanvas, useElementWidth, usePalette } from '../app/hooks';
import { showInView } from '../state/show-in';
import type { ViewId } from '../state/types';
import { originInfo } from '../theme/origin';
import { fmtDuration, fmtRange, fmtShare } from '../util/format';
import { drawDeoptMark, drawSelf } from '../view/draw-bars';
import { deoptNote } from '../view/deopt-text';
import { DeoptLegendItem } from './DeoptLegendItem';
import { roundedRectPath } from '../view/draw-shapes';
import { flameFill } from '../view/flame-fill';
import { FLAME, flameHeight, flameRects, hitRect } from '../view/flame-geometry';
import type { FlameRect } from '../view/flame-geometry';
import { Hint } from './Hint';
import { Legend } from './Legend';
import { PopoverSurface } from './PopoverSurface';

interface MenuState {
  x: number;
  y: number;
  fn: number;
}

const TEXT = {
  showInWaterfall: 'Show in waterfall',
  showCallers: 'Show callers',
  showInCallGraph: 'Show in call graph',
  loading: 'Loading flame graph…',
  allSamples: 'All samples',
  allSamplesRange: (range: string) => `All samples · ${range}`,
  seconds: (value: string) => `${value} s`,
  sort: 'Sort',
  heavy: 'Left-heavy, by total time',
  alpha: 'Alphabetical',
  color: 'Color',
  byOrigin: 'By origin',
  bySelf: 'By self time',
  layout: 'Layout',
  icicle: 'Icicle',
  flames: 'Flames',
  differenceColors: 'Difference colors',
  faster: 'Faster than baseline',
  slower: 'Slower than baseline',
  intensity: 'Intensity = size of the change',
  hint: 'Identical stacks are merged. Width is how long a frame was on the stack; left to right is not time. For order, use the Waterfall.',
  zoomPath: 'Zoom path',
  clickToZoom: 'Click a frame to zoom into it',
  alphabetical: 'alphabetical',
  heaviestFirst: 'heaviest first',
  caption: (order: string) => `width = share of samples · order = ${order}, not time`,
  flameKind: 'Flame',
  plot: (kind: string, frames: number, widest: string) =>
    `${kind} graph of ${frames} frames. ${widest} is the widest top-level frame.`,
  frames: 'Frames, widest first',
  frameFaster: ', faster than baseline',
  frameSlower: ', slower than baseline',
  frame: (
    name: string,
    change: string,
    origin: string,
    total: string,
    share: string,
    deopt: string,
  ) => `${name}${change}, ${origin}, ${total} total, ${share} of samples${deopt}`,
  frameDeopt: (note: string) => `, ${note}`,
  tipLoc: (loc: string) => ` · ${loc}`,
  tipTotals: (total: string, share: string, self: string) =>
    `Total ${total} · ${share} of samples · self ${self}`,
  tipSame: 'About the same as the baseline',
  tipFaster: 'Faster than the baseline',
  tipSlower: 'Slower than the baseline',
  tipActions: 'Double-click for source · right-click for Show in waterfall',
  menu: 'Frame actions',
  select: 'Select',
  axisStart: '0%',
  axisQuarter: '25%',
  axisHalf: (half: string) => `50% of samples (${half})`,
  axisThreeQuarters: '75%',
  axisEnd: '100%',
  dimmed: 'Dependency, Node and native frames are dimmed, never hidden.',
  plumbingMerged: 'Plumbing frames are merged into their callers. ',
  plumbingShown: 'Plumbing frames are shown. ',
  keys: 'Keys: f focus · m merge · c collapse package · i invert.',
} as const;

const SHOW_IN: Array<{ view: ViewId; label: string }> = [
  { view: 'waterfall', label: TEXT.showInWaterfall },
  { view: 'functions', label: TEXT.showCallers },
  { view: 'callgraph', label: TEXT.showInCallGraph },
];

export function FlameGraph() {
  const { client, scope, scopeKey, snap, dispatch, selection, select, state, openDock } = useApp();
  const hoverFn = useHoverFn();
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
        if (!isRoot)
          drawSelf(ctx, pal, r.x, r.y, r.w, r.h, data.selfUs[i] ?? 0, data.totalUs[i] ?? 0);
        if (!isRoot && (data.deopts[i] ?? 0) > 0) drawDeoptMark(ctx, pal, r.x, r.y, r.w, r.h);
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
        {TEXT.loading}
      </div>
    );

  const height = flameHeight(data, width);
  const rangeLabel = snap.range ? fmtRange(snap.range[0], snap.range[1]) : null;
  const crumbBase = rangeLabel ? TEXT.allSamplesRange(rangeLabel) : TEXT.allSamples;
  const rootSec = data.rootUs / 1_000_000;
  const half = TEXT.seconds((rootSec / 2).toFixed(rootSec >= 10 ? 1 : 2));

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
          <label htmlFor="fg-sort">{TEXT.sort}</label>
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
            <option value="heavy">{TEXT.heavy}</option>
            <option value="alpha">{TEXT.alpha}</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="fg-color">{TEXT.color}</label>
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
            <option value="origin">{TEXT.byOrigin}</option>
            <option value="self">{TEXT.bySelf}</option>
          </select>
        </div>
        <div className="seg" role="group" aria-label={TEXT.layout}>
          <button
            type="button"
            aria-pressed={layout === 'icicle'}
            onClick={() => dispatch({ type: 'options', options: { layout: 'icicle' } })}
          >
            {TEXT.icicle}
          </button>
          <button
            type="button"
            aria-pressed={layout === 'flames'}
            onClick={() => dispatch({ type: 'options', options: { layout: 'flames' } })}
          >
            {TEXT.flames}
          </button>
        </div>
        {data.delta ? (
          <ul className="legend" aria-label={TEXT.differenceColors}>
            <li className="legend-item">
              <span
                className="legend-swatch"
                style={{ background: 'var(--c-diff-faster)' }}
                aria-hidden="true"
              />
              {TEXT.faster}
            </li>
            <li className="legend-item">
              <span
                className="legend-swatch"
                style={{ background: 'var(--c-diff-slower)' }}
                aria-hidden="true"
              />
              {TEXT.slower}
            </li>
            <li className="legend-item">{TEXT.intensity}</li>
          </ul>
        ) : (
          <Legend />
        )}
        {data?.deopts.some((n) => n > 0) ? <DeoptLegendItem /> : null}
      </div>
      <Hint id="hint-flame">{TEXT.hint}</Hint>
      <div className="toolbar-row" style={{ gap: 8 }}>
        <nav aria-label={TEXT.zoomPath} className="flame-crumbs">
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
          {data.crumbs.length === 0 ? <span className="muted">{TEXT.clickToZoom}</span> : null}
        </nav>
        <p className="axis-caption">
          {TEXT.caption(sort === 'alpha' ? TEXT.alphabetical : TEXT.heaviestFirst)}
        </p>
      </div>
      <div className="flame-scroll">
        <div className="flame-inner">
          <div
            ref={setPlotEl}
            className="flame-plot"
            role="img"
            aria-label={TEXT.plot(
              layout === 'icicle' ? TEXT.icicle : TEXT.flameKind,
              data.length,
              data.names[1] ?? '',
            )}
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
            <div className="flame-mirror" role="list" aria-label={TEXT.frames}>
              {mirror.map((r) => {
                const i = r.index;
                const dd = data.delta ? (data.delta[i] ?? 0) : null;
                const change =
                  dd === null || Math.abs(dd) < 0.05
                    ? ''
                    : dd < 0
                      ? TEXT.frameFaster
                      : TEXT.frameSlower;
                const label = TEXT.frame(
                  data.names[i] ?? '',
                  change,
                  originInfo(data.origin[i] ?? 4).label,
                  fmtDuration(data.totalUs[i] ?? 0),
                  fmtShare((data.totalUs[i] ?? 0) / (data.rootUs || 1)),
                  (data.deopts[i] ?? 0) > 0 ? TEXT.frameDeopt(deoptNote(data.deopts[i] ?? 0)) : '',
                );
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
                      {TEXT.tipLoc(data.locs[hovered] ?? '')}
                    </span>
                  ) : null}
                </span>
                <span className="num" style={{ fontSize: 12, lineHeight: '16px' }}>
                  {TEXT.tipTotals(
                    fmtDuration(hoverTotal),
                    fmtShare(hoverTotal / (data.rootUs || 1)),
                    fmtDuration(hoverSelf),
                  )}
                </span>
                {data.delta ? (
                  <span className="tooltip-sub">
                    {Math.abs(data.delta[hovered] ?? 0) < 0.05
                      ? TEXT.tipSame
                      : (data.delta[hovered] ?? 0) < 0
                        ? TEXT.tipFaster
                        : TEXT.tipSlower}
                  </span>
                ) : null}
                {(data.deopts[hovered] ?? 0) > 0 ? (
                  <span className="tooltip-sub">{deoptNote(data.deopts[hovered] ?? 0)}</span>
                ) : null}
                <span className="tooltip-sub">{TEXT.tipActions}</span>
              </div>
            ) : null}
            {menu ? (
              <PopoverSurface
                id="flame-context-menu"
                role="menu"
                label={TEXT.menu}
                onClose={() => setMenu(null)}
                style={{ left: menu.x, top: menu.y, minWidth: 200 }}
              >
                {SHOW_IN.map((item) => (
                  <button
                    key={item.view}
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    onClick={() => {
                      dispatch(showInView(item.view, menu.fn));
                      setMenu(null);
                    }}
                  >
                    {item.label}
                  </button>
                ))}
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    select({ kind: 'fn', fn: menu.fn });
                    setMenu(null);
                  }}
                >
                  {TEXT.select}
                </button>
              </PopoverSurface>
            ) : null}
          </div>
          <div className="flame-axis" aria-hidden="true">
            <span style={{ left: 0 }}>{TEXT.axisStart}</span>
            <span style={{ left: '25%', transform: 'translateX(-50%)' }}>{TEXT.axisQuarter}</span>
            <span style={{ left: '50%', transform: 'translateX(-50%)' }}>
              {TEXT.axisHalf(half)}
            </span>
            <span style={{ left: '75%', transform: 'translateX(-50%)' }}>
              {TEXT.axisThreeQuarters}
            </span>
            <span style={{ right: 0 }}>{TEXT.axisEnd}</span>
          </div>
        </div>
      </div>
      <p className="view-footer" style={{ display: 'block' }}>
        {TEXT.dimmed}{' '}
        {snap.transforms.some((t) => t.k === 'merge-plumbing')
          ? TEXT.plumbingMerged
          : TEXT.plumbingShown}
        {TEXT.keys}
      </p>
    </>
  );
}
