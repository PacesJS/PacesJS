import { RESUMED_TIP } from '../view/waterfall-labels';
import { Legend } from './Legend';

/** The footer legend of the waterfall: origin colors, critical path, hatching, waits, resumed rows, deep calls. */
export function WaterfallLegend({ threshold }: { threshold: string }) {
  return (
    <div className="view-footer">
      <Legend label="Origin colors" />
      <span className="wf-legend-item">
        <span className="wf-legend-swatch swatch-critical" aria-hidden="true" />
        Critical path: widest child at each level
      </span>
      <span className="wf-legend-item">
        <span className="wf-legend-swatch swatch-hatch" aria-hidden="true" />
        Under {threshold}, below sampling precision
      </span>
      <span className="wf-legend-item">
        <span className="wf-legend-swatch swatch-wait" aria-hidden="true" />
        Idle wait between an await and its continuation
      </span>
      <span className="wf-legend-item" title={RESUMED_TIP}>
        <span aria-hidden="true" className="wf-resumed">
          ↻
        </span>
        Resumed after an await: attached to the call that started it (inferred; run with --async for
        exact)
      </span>
      <span className="wf-legend-item">
        <span className="wf-depth" aria-hidden="true">
          ⋯ N
        </span>
        Depth of a deep call. Past level 12 it is a button: Focus here (or f) makes the call the
        root
      </span>
      <span className="view-footer-end">
        Arrows walk rows · Enter opens source · f focus · Backspace back
      </span>
    </div>
  );
}
