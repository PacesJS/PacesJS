import { LEGEND_ORDER, originInfo } from '../theme/origin';

const TEXT = {
  originColors: 'Origin colors',
} as const;

interface LegendProps {
  label?: string;
  /** Origin indexes to show; defaults to all six. */
  origins?: readonly number[];
}

/** Origin legend: a color swatch next to its text label, so color is never the only cue. */
export function Legend({ label = TEXT.originColors, origins = LEGEND_ORDER }: LegendProps) {
  return (
    <ul className="legend" aria-label={label}>
      {origins.map((o) => {
        const info = originInfo(o);
        const style = { background: `var(${o === 0 ? info.solid : info.dim})` };
        return (
          <li key={info.key} className="legend-item">
            <span className="legend-swatch" style={style} aria-hidden="true" />
            {info.label}
          </li>
        );
      })}
    </ul>
  );
}
