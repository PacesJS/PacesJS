import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { HoverTip } from '../app/useHoverTip';

const WIDTH = 320;
const HEIGHT = 96;

/** Beside the pointer, inside the viewport, below the target or above it near the bottom. */
export function laneTipStyle(tip: HoverTip, vw: number, vh: number): CSSProperties {
  const left = Math.max(8, Math.min(tip.x - WIDTH / 2, vw - WIDTH - 8));
  const below = tip.y + 8 + HEIGHT <= vh;
  return {
    position: 'fixed',
    left,
    top: below ? tip.y + 8 : Math.max(8, tip.top - 8 - HEIGHT),
    maxWidth: WIDTH,
    zIndex: 40,
  };
}

interface LaneTipProps {
  tip: HoverTip | null;
}

/** The tooltip of a lane's hover target: a title and short lines under it. */
export function LaneTip({ tip }: LaneTipProps) {
  if (!tip) return null;
  return createPortal(
    <div
      role="tooltip"
      className="tooltip is-wrapping"
      style={laneTipStyle(tip, globalThis.innerWidth, globalThis.innerHeight)}
    >
      <span className="tooltip-title">{tip.title}</span>
      {tip.lines.map((l) => (
        <span key={l} className="tooltip-sub">
          {l}
        </span>
      ))}
    </div>,
    document.body,
  );
}
