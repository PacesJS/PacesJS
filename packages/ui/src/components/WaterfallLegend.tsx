import { RESUMED_TIP } from '../view/waterfall-labels';
import { Legend } from './Legend';

const TEXT = {
  originColors: 'Origin colors',
  criticalPath: 'Critical path: widest child at each level',
  underThreshold: (threshold: string) => `Under ${threshold}, below sampling precision`,
  idleWait: 'Idle wait between an await and its continuation',
  resumedGlyph: '↻',
  resumed:
    'Resumed after an await: attached to the call that started it (inferred; run with --async for exact)',
  depthGlyph: '⋯ N',
  depth:
    'Depth of a deep call. Past level 12 it is a button: Focus here (or f) makes the call the root',
  keys: 'Arrows walk rows · Enter opens source · f focus · Backspace back',
} as const;

/** The footer legend of the waterfall: origin colors, critical path, hatching, waits, resumed rows, deep calls. */
export function WaterfallLegend({ threshold }: { threshold: string }) {
  return (
    <div className="view-footer">
      <Legend label={TEXT.originColors} />
      <span className="wf-legend-item">
        <span className="wf-legend-swatch swatch-critical" aria-hidden="true" />
        {TEXT.criticalPath}
      </span>
      <span className="wf-legend-item">
        <span className="wf-legend-swatch swatch-hatch" aria-hidden="true" />
        {TEXT.underThreshold(threshold)}
      </span>
      <span className="wf-legend-item">
        <span className="wf-legend-swatch swatch-wait" aria-hidden="true" />
        {TEXT.idleWait}
      </span>
      <span className="wf-legend-item" title={RESUMED_TIP}>
        <span aria-hidden="true" className="wf-resumed">
          {TEXT.resumedGlyph}
        </span>
        {TEXT.resumed}
      </span>
      <span className="wf-legend-item">
        <span className="wf-depth" aria-hidden="true">
          {TEXT.depthGlyph}
        </span>
        {TEXT.depth}
      </span>
      <span className="view-footer-end">{TEXT.keys}</span>
    </div>
  );
}
