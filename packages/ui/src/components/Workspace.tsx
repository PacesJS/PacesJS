import { useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import { useApp } from '../app/context';
import { DOCK_LIMITS, DEFAULT_PREFS, clamp, clampDock } from '../state/prefs';
import type { DockPrefs } from '../state/prefs';
import { DetailsDrawer } from './DetailsDrawer';
import { MainView } from './MainView';
import { SourceOverlay } from './SourceOverlay';
import { SourcePanel } from './SourcePanel';

const KEY_STEP_FRACTION = 0.02;
const KEY_STEP_PX = 24;

interface HandleProps {
  dock: DockPrefs;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onLive(dock: DockPrefs | null): void;
  onCommit(dock: DockPrefs): void;
}

/** Drag handle between the views and the dock: pointer drag, arrow keys, double-click to reset. */
function DockHandle({ dock, containerRef, onLive, onCommit }: HandleProps) {
  const dragging = useRef(false);
  const right = dock.orientation === 'right';

  const sized = (e: PointerEvent): DockPrefs => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return dock;
    return clampDock(
      right
        ? { ...dock, widthFraction: (box.right - e.clientX) / Math.max(1, box.width) }
        : { ...dock, heightPx: box.bottom - e.clientY },
    );
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    const grow = right ? e.key === 'ArrowLeft' : e.key === 'ArrowUp';
    const shrink = right ? e.key === 'ArrowRight' : e.key === 'ArrowDown';
    if (!grow && !shrink) return;
    e.preventDefault();
    const sign = grow ? 1 : -1;
    onCommit(
      clampDock(
        right
          ? { ...dock, widthFraction: dock.widthFraction + sign * KEY_STEP_FRACTION }
          : { ...dock, heightPx: dock.heightPx + sign * KEY_STEP_PX },
      ),
    );
  };

  const now = right ? Math.round(dock.widthFraction * 100) : Math.round(dock.heightPx);
  const limits = right
    ? [DOCK_LIMITS.widthFraction.min * 100, DOCK_LIMITS.widthFraction.max * 100]
    : [DOCK_LIMITS.heightPx.min, DOCK_LIMITS.heightPx.max];
  return (
    <div
      role="separator"
      aria-orientation={right ? 'vertical' : 'horizontal'}
      aria-label="Resize source dock"
      aria-valuenow={clamp(now, limits[0] ?? 0, limits[1] ?? 100)}
      aria-valuemin={limits[0]}
      aria-valuemax={limits[1]}
      aria-valuetext={right ? `${now}% of the width` : `${now} pixels high`}
      tabIndex={0}
      className={`dock-handle is-${dock.orientation}`}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging.current = true;
      }}
      onPointerMove={(e) => {
        if (dragging.current) onLive(sized(e));
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        dragging.current = false;
        onCommit(sized(e));
        onLive(null);
      }}
      onPointerCancel={() => {
        dragging.current = false;
        onLive(null);
      }}
      onDoubleClick={() =>
        onCommit({
          ...dock,
          widthFraction: DEFAULT_PREFS.dock.widthFraction,
          heightPx: DEFAULT_PREFS.dock.heightPx,
        })
      }
      onKeyDown={onKeyDown}
    />
  );
}

/**
 * The views and details on one side, the source dock on the other (or below). The dock is
 * resizable and its size is remembered; the Source tab replaces the dock with the full view.
 */
export function Workspace() {
  const { state, dispatch } = useApp();
  const ref = useRef<HTMLDivElement | null>(null);
  const [live, setLive] = useState<DockPrefs | null>(null);
  const dock = live ?? state.prefs.dock;
  const { dockCollapsed: dockCollapsedNow } = useApp();
  const collapsed = dockCollapsedNow;

  const style = {
    ['--dock-frac' as string]: dock.widthFraction,
    ['--dock-h' as string]: `${dock.heightPx}px`,
  } as CSSProperties;

  return (
    <div
      ref={ref}
      className={`workspace is-${dock.orientation}${collapsed ? ' is-collapsed' : ''}`}
      style={style}
    >
      <div className="app-col">
        <MainView />
        <DetailsDrawer />
      </div>
      {collapsed ? null : (
        <DockHandle
          dock={dock}
          containerRef={ref}
          onLive={setLive}
          onCommit={(d) => dispatch({ type: 'prefs', prefs: { dock: d } })}
        />
      )}
      <aside
        aria-label="Source dock"
        className={`dock is-${dock.orientation}`}
        data-keeps-selection
      >
        <SourcePanel />
      </aside>
      {state.dockMaximized ? <SourceOverlay /> : null}
    </div>
  );
}
