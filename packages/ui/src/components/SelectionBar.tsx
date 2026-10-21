import { useApp } from '../app/context';
import {
  CLEAR_SELECTION,
  clearShowMeAction,
  hasSelection,
  isShowing,
  showMeContext,
  showingText,
} from '../state/showme';
import { fmtRange } from '../util/format';

const TEXT = {
  range: (range: string) => `range ${range}`,
  aTimeRange: 'a time range',
  selected: (target: string) => `Selected: ${target}`,
  clearLabel: 'Clear selection (Esc)',
  clear: 'Clear selection',
  escKey: 'Esc',
} as const;

/** "Showing: ..." for the active finding, plus the way out: a visible Clear selection chip. */
export function SelectionBar() {
  const { summary, snap, selection, search, dispatch } = useApp();
  const ctx = showMeContext(summary);
  const finding = summary.findings.find((f) => isShowing(f, snap, search, ctx));
  if (!hasSelection(snap) && !finding) return null;
  const target =
    selection.name || (snap.range ? TEXT.range(fmtRange(snap.range[0], snap.range[1])) : '');
  return (
    <div className="selection-bar">
      <span className="selection-bar-text">
        {finding ? showingText(finding, target) : TEXT.selected(target || TEXT.aTimeRange)}
      </span>
      <button
        type="button"
        className="chip-action"
        aria-label={TEXT.clearLabel}
        onClick={() => dispatch(finding ? clearShowMeAction(finding, snap) : CLEAR_SELECTION)}
      >
        {TEXT.clear} <kbd className="kbd">{TEXT.escKey}</kbd>
      </button>
    </div>
  );
}
