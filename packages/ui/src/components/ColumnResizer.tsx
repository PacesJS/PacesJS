import { useRef } from 'react';
import type { WfColumns } from '../state/prefs';
import { resizeColumn } from '../view/waterfall-columns';
import type { ColumnKey } from '../view/waterfall-columns';

const KEY_STEP_PX = 8;

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
export function ColumnResizer({
  column,
  label,
  cols,
  edge,
  onLive,
  onCommit,
  onFit,
}: ResizerProps) {
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
