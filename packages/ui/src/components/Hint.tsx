import { useApp } from '../app/context';
import { Icon } from './Icon';

const TEXT = {
  dismiss: 'Dismiss tip',
} as const;

interface HintProps {
  /** Stable id so a dismissed hint stays dismissed (persisted through settings). */
  id: string;
  children: string;
}

/** First-run tip: one per view, explains its axis, dismissible. */
export function Hint({ id, children }: HintProps) {
  const { state, dispatch } = useApp();
  if (state.dismissed.includes(id)) return null;
  return (
    <div role="note" className="note">
      <Icon name="info" size={16} />
      <span className="note-text">{children}</span>
      <button
        type="button"
        className="note-btn"
        aria-label={TEXT.dismiss}
        onClick={() => dispatch({ type: 'dismiss-hint', id })}
      >
        <Icon name="close" size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
