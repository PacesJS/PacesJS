import { memo, useSyncExternalStore } from 'react';
import { measureText } from '../app/hooks';
import type { HoverStore } from '../app/hover';
import type { WaterfallRow } from '../data/types';
import type { Transform } from '../state/types';
import { originColor } from '../theme/origin';
import { fmtShare } from '../util/format';
import { WF } from '../view/waterfall-geometry';
import { deoptNote } from '../view/deopt-text';
import { guideLevels } from '../view/waterfall-indent';
import { RESUMED_TIP, durLabel } from '../view/waterfall-labels';
import { waterfallRowModel } from '../view/waterfall-row-model';
import { Icon } from './Icon';

const TEXT = {
  descriptionSep: ' · ',
  itself: 'itself',
  task: 'task',
  row: (
    name: string,
    origin: string,
    duration: string,
    share: string,
    of: string,
    critical: boolean,
  ) => `${name}, ${origin}, ${duration}, ${share} of ${of}${critical ? ', critical path' : ''}`,
  focusLabel: (name: string) => `Focus here: ${name}`,
  focusTitle: (level: number) =>
    `Level ${level}. Focus here: make this call the root of the waterfall (f)`,
  focus: 'Focus',
  level: (level: number) => `Level ${level}`,
  resumedGlyph: '↻',
  resumed: 'resumed after an await, inferred',
} as const;

interface WaterfallRowViewProps {
  r: WaterfallRow;
  /** Offset from the top of the rows, in px. */
  top: number;
  selected: boolean;
  /** The same function as the selected one, elsewhere in the tree. */
  linked: boolean;
  collapsed: boolean;
  callWidth: number;
  fontSans: string;
  functionCount: number;
  threshold: string;
  foldLabel: string;
  whole: 'run' | 'task';
  winStart: number;
  winEnd: number;
  barX0: number;
  barX1: number;
  hiddenKids: number;
  cpuUs: number;
  /** Which row the pointer is on; a row subscribes to its own answer only. */
  hover: HoverStore;
  onSelect(r: WaterfallRow): void;
  onToggle(id: number): void;
  onOpen(): void;
  onFocus(transform: Transform): void;
  onBarEnter(el: HTMLElement, text: string): void;
  onBarLeave(): void;
}

/**
 * One waterfall row. Memoized: pointing at a row re-renders the row that lost and the row that gained
 * the pointer, not the whole table.
 */
export const WaterfallRowView = memo(function WaterfallRowView({
  r,
  top,
  selected,
  linked,
  collapsed,
  callWidth,
  fontSans,
  functionCount,
  threshold,
  foldLabel,
  whole,
  winStart,
  winEnd,
  barX0,
  barX1,
  hiddenKids,
  cpuUs,
  hover,
  onSelect,
  onToggle,
  onOpen,
  onFocus,
  onBarEnter,
  onBarLeave,
}: WaterfallRowViewProps) {
  const hovered = useSyncExternalStore(
    hover.subscribe,
    () => hover.get() === r.id,
    () => false,
  );
  const m = waterfallRowModel(r, {
    callWidth,
    fontSans,
    measure: measureText,
    functionCount,
    threshold,
    foldLabel,
    whole,
    winStart,
    winEnd,
    barX0,
    barX1,
    hiddenKids,
    cpuUs,
  });
  return (
    <div
      role="row"
      aria-level={r.depth + 1}
      aria-expanded={r.hasChildren ? !collapsed : undefined}
      aria-selected={selected}
      aria-description={
        [m.details, m.hiddenNote, r.deopts > 0 ? deoptNote(r.deopts) : '']
          .filter(Boolean)
          .join(TEXT.descriptionSep) || undefined
      }
      aria-label={TEXT.row(
        r.name,
        m.originLabel,
        durLabel(r, threshold),
        fmtShare(r.share),
        r.kind === 'task' ? TEXT.itself : TEXT.task,
        r.critical,
      )}
      className={`wf-row${selected ? ' is-selected' : ''}${hovered ? ' is-hover' : ''}${linked ? ' is-linked' : ''}`}
      style={{ top }}
      onClick={() => onSelect(r)}
      onDoubleClick={onOpen}
      onPointerEnter={() => hover.set(r.id)}
      onPointerLeave={() => hover.set(null)}
    >
      <div
        className="wf-name"
        role="cell"
        title={m.nameTitle}
        style={{
          paddingLeft: m.indent,
          ['--wf-guides' as string]: guideLevels(r.depth),
        }}
      >
        {r.hasChildren ? (
          <span
            className="wf-twisty"
            aria-hidden="true"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(r.id);
            }}
            style={{ transform: collapsed ? 'rotate(-90deg)' : undefined }}
          >
            <Icon name="chevron-down" size={14} strokeWidth={2} />
          </span>
        ) : (
          <span style={{ width: 14, flex: 'none' }} />
        )}
        <span
          className="wf-dot"
          aria-hidden="true"
          style={{ background: originColor(r.origin, false) }}
        />
        {m.focusAs ? (
          <button
            type="button"
            className="wf-depth is-action"
            aria-label={TEXT.focusLabel(r.name)}
            title={TEXT.focusTitle(r.depth + 1)}
            onClick={(e) => {
              e.stopPropagation();
              if (m.focusAs) onFocus(m.focusAs);
            }}
          >
            {hovered || selected ? TEXT.focus : m.depthBadge}
          </button>
        ) : m.badged ? (
          <span className="wf-depth" aria-hidden="true" title={TEXT.level(r.depth + 1)}>
            {m.depthBadge}
          </span>
        ) : null}
        <span
          className={`wf-label${m.isUser ? ' is-user' : ''}${r.kind === 'wait' || r.kind === 'fold' ? ' is-wait' : ''}`}
        >
          {m.label}
        </span>
        {r.resumed ? (
          <span className="wf-resumed" title={RESUMED_TIP}>
            <span aria-hidden="true">{TEXT.resumedGlyph}</span>
            <span className="sr-only">{TEXT.resumed}</span>
          </span>
        ) : null}
        <span className="wf-loc">{m.where}</span>
      </div>
      <div className="wf-bar-cell" role="cell" aria-hidden="true" />
      {m.barBox ? (
        <div
          className="wf-bar-hit"
          aria-hidden="true"
          style={{ left: m.barBox.x, width: m.barBox.w, top: WF.barTop, height: WF.barH }}
          onPointerEnter={(e) => onBarEnter(e.currentTarget, m.details)}
          onPointerLeave={onBarLeave}
        />
      ) : null}
      <div className="wf-time" role="cell">
        {durLabel(r, threshold)}
      </div>
      <div className="wf-share" role="cell">
        {fmtShare(r.share)}
      </div>
    </div>
  );
});
