import { useRef, useState } from 'react';
import { useCanvas, usePalette } from '../app/hooks';
import type { LaneData } from '../data/types';
import { drawLane, taskAtTime } from '../view/draw-lane';
import { fmtDuration } from '../util/format';
import { clamp } from '../view/scale';

interface LanePlotProps {
  lane: LaneData;
  ticks: number[];
  selectedTask: number;
  /** Fires with a drag range in microseconds. */
  onRange(from: number, to: number): void;
  onSelectTask(task: number): void;
  onHoverTask(task: number): void;
  hoveredTask: number;
}

const DRAG_PX = 4;

/** One track lane: canvas for CPU, tasks, GC; pointer handling for click and drag-to-select. */
export function LanePlot({
  lane,
  ticks,
  selectedTask,
  onRange,
  onSelectTask,
  onHoverTask,
  hoveredTask,
}: LanePlotProps) {
  const pal = usePalette();
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  const [tip, setTip] = useState<{ x: number; task: number } | null>(null);

  const canvasRef = useCanvas(
    (ctx, { width, height }) => {
      drawLane(ctx, width, height, lane, pal, {
        selectedTask,
        hoverTask: hoveredTask,
        tickUs: ticks,
      });
    },
    [lane, pal, selectedTask, hoveredTask, ticks],
  );

  const usAt = (clientX: number): number => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    const f = clamp((clientX - rect.left) / rect.width, 0, 1);
    return f * lane.durationUs;
  };
  const tolUs = (): number => {
    const rect = plotRef.current?.getBoundingClientRect();
    return rect && rect.width > 0 ? (3 / rect.width) * lane.durationUs : 0;
  };
  const px = (clientX: number): number =>
    clientX - (plotRef.current?.getBoundingClientRect().left ?? 0);

  const tipTask = tip ? tip.task : -1;
  const tipStart = tipTask >= 0 ? (lane.taskStart[tipTask] ?? 0) : 0;
  const tipDur = tipTask >= 0 ? (lane.taskEnd[tipTask] ?? 0) - tipStart : 0;

  return (
    <div
      ref={plotRef}
      className="lane-plot"
      data-keeps-selection
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ x0: px(e.clientX), x1: px(e.clientX) });
      }}
      onPointerMove={(e) => {
        if (drag) {
          setDrag({ ...drag, x1: px(e.clientX) });
          return;
        }
        const t = taskAtTime(lane, usAt(e.clientX), tolUs());
        onHoverTask(t);
        setTip(t >= 0 ? { x: px(e.clientX), task: t } : null);
      }}
      onPointerLeave={() => {
        onHoverTask(-1);
        setTip(null);
      }}
      onPointerUp={(e) => {
        if (!drag) return;
        const moved = Math.abs(drag.x1 - drag.x0) > DRAG_PX;
        const a = usAt(e.clientX - (px(e.clientX) - drag.x0));
        const b = usAt(e.clientX);
        setDrag(null);
        if (moved) onRange(Math.min(a, b), Math.max(a, b));
        else onSelectTask(taskAtTime(lane, usAt(e.clientX), tolUs()));
      }}
      onPointerCancel={() => setDrag(null)}
    >
      <canvas ref={canvasRef} className="lane-canvas" aria-hidden="true" />
      {drag && Math.abs(drag.x1 - drag.x0) > DRAG_PX ? (
        <div
          className="range-overlay"
          style={{ left: Math.min(drag.x0, drag.x1), width: Math.abs(drag.x1 - drag.x0) }}
        />
      ) : null}
      {tip && tipTask >= 0 && !drag ? (
        <div
          role="tooltip"
          className="tooltip"
          style={{ top: 2, left: Math.min(tip.x + 14, 9999) }}
        >
          <span className="tooltip-title">
            {lane.taskLabels[tipTask] || 'task'} · {fmtDuration(tipDur)}
          </span>
          <span className="tooltip-sub">
            at {(tipStart / 1_000_000).toFixed(2)} s
            {lane.taskLong[tipTask] === 1 ? ' · long task' : ''}
            {tipTask === selectedTask ? ' · selected' : ''}
          </span>
        </div>
      ) : null}
    </div>
  );
}
