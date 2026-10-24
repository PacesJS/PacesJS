import { useState } from 'react';
import type { RunMark } from '../data/marks';
import { fmtSeconds } from '../util/format';
import { markRange } from '../view/mark-range';
import type { MarkSpan } from '../view/mark-range';
import { Icon } from './Icon';
import { Popover } from './Popover';

const TEXT = {
  heading: 'Marks',
  flag: (label: string, at: string) => `${label}, at ${at}`,
  menu: (label: string) => `${label} actions`,
  before: (label: string) => `Focus before ${label}`,
  after: (label: string) => `Focus after ${label}`,
  between: (a: string, b: string) => `Focus between ${a} and ${b}`,
} as const;

interface MarkFlagsProps {
  marks: readonly RunMark[];
  durationUs: number;
  onRange(from: number, to: number): void;
}

/** Flags on the time axis, one per mark; each opens a menu to focus on the time around it. */
export function MarkFlags({ marks, durationUs, onRange }: MarkFlagsProps) {
  const [open, setOpen] = useState<number | null>(null);
  if (marks.length === 0) return null;

  const items = (index: number): Array<{ name: string; span: MarkSpan }> => {
    const here = marks[index] as RunMark;
    const others = marks.flatMap((m, i) =>
      i === index
        ? []
        : [
            {
              name:
                i < index ? TEXT.between(m.label, here.label) : TEXT.between(here.label, m.label),
              span: { kind: 'between', other: i } as MarkSpan,
            },
          ],
    );
    return [
      { name: TEXT.before(here.label), span: { kind: 'before' } },
      { name: TEXT.after(here.label), span: { kind: 'after' } },
      ...others,
    ];
  };

  return (
    <div className="lane-grid mark-row">
      <div className="mark-heading">{TEXT.heading}</div>
      <div className="mark-track">
        {marks.map((m, i) => (
          <div
            key={`${m.us}-${i}`}
            className="mark-anchor"
            style={{ left: `${Math.min(1, m.us / durationUs) * 100}%` }}
          >
            <Popover
              open={open === i}
              onOpenChange={(o) => setOpen(o ? i : null)}
              role="menu"
              label={TEXT.menu(m.label)}
              trigger={(props) => (
                <button
                  type="button"
                  className="mark-flag"
                  aria-label={TEXT.flag(m.label, fmtSeconds(m.us, 2))}
                  {...props}
                >
                  <Icon name="flag" size={14} />
                  <span className="mark-flag-label">{m.label}</span>
                </button>
              )}
            >
              {(close) =>
                items(i).map((item) => {
                  const range = markRange(marks, i, item.span, durationUs);
                  return (
                    <button
                      key={item.name}
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      disabled={range === null}
                      onClick={() => {
                        if (range) onRange(range[0], range[1]);
                        close();
                      }}
                    >
                      {item.name}
                    </button>
                  );
                })
              }
            </Popover>
          </div>
        ))}
      </div>
    </div>
  );
}
