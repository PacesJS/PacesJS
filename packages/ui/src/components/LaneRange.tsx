import { useApp } from '../app/context';

interface LaneRangeProps {
  durationUs: number;
}

/** The selected range, drawn over one lane; every lane shows the same one. */
export function LaneRange({ durationUs }: LaneRangeProps) {
  const { snap } = useApp();
  const range = snap.range;
  if (!range || durationUs <= 0) return null;
  const from = Math.min(1, Math.max(0, range[0] / durationUs));
  const to = Math.min(1, Math.max(0, range[1] / durationUs));
  return (
    <span
      className="range-overlay lane-range"
      aria-hidden="true"
      style={{ left: `${from * 100}%`, width: `${(to - from) * 100}%` }}
    />
  );
}
