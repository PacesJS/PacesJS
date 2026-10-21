import { useApp } from '../app/context';
import type { SourceState } from '../app/useSource';
import { originColor } from '../theme/origin';
import { fmtDuration } from '../util/format';
import { Icon } from './Icon';

const TEXT = {
  calleeTime: 'Time in callees',
} as const;

interface SourceReasonNoteProps {
  source: SourceState;
}

/** Time in callees, largest first: the answer when a function has no time of its own. */
function CalleeTime({ source }: SourceReasonNoteProps) {
  const { select } = useApp();
  return (
    <ul className="callee-time" aria-label={TEXT.calleeTime}>
      {source.callees.slice(0, 8).map((c) => (
        <li key={`${c.fn}-${c.name}`}>
          <button
            type="button"
            className="callee-time-row"
            disabled={c.fn === null}
            onClick={() => c.fn !== null && select({ kind: 'fn', fn: c.fn })}
          >
            <span
              className="wf-dot"
              aria-hidden="true"
              style={{ background: originColor(c.origin, false) }}
            />
            <span className="callee-time-name">{c.name}</span>
            <span className="num">{fmtDuration(c.us)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Why there is no source (or only generated code), and what to do about it. */
export function SourceReasonNote({ source }: SourceReasonNoteProps) {
  const r = source.reason;
  if (!r) return null;
  return (
    <div role="note" className={`source-reason is-${r.kind}`}>
      <Icon name={r.showsText ? 'info' : 'alert'} size={18} />
      <div>
        <strong className="source-reason-title">{r.title}</strong>
        <p className="source-reason-hint">{r.hint}</p>
        {r.kind === 'no-self-time' ? <CalleeTime source={source} /> : null}
      </div>
    </div>
  );
}
