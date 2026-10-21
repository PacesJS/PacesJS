import { useApp } from '../app/context';
import { Icon } from './Icon';

const TEXT = {
  wrap: 'Wrap long lines',
} as const;

interface WrapButtonProps {
  wrap: boolean;
}

/** The wrap-long-lines switch, shared by the dock and the maximized view. */
export function WrapButton({ wrap }: WrapButtonProps) {
  const { state, dispatch } = useApp();
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={TEXT.wrap}
      aria-pressed={wrap}
      title={TEXT.wrap}
      onClick={() =>
        dispatch({ type: 'prefs', prefs: { dock: { ...state.prefs.dock, wrap: !wrap } } })
      }
    >
      <Icon name="wrap" />
    </button>
  );
}
