import { useApp } from '../app/context';
import { useAsync } from '../app/hooks';
import { originInfo } from '../theme/origin';
import { fmtDuration } from '../util/format';

const TEXT = {
  show: 'Show',
  hidden: (label: string) => `${label} are hidden: click to show them`,
  hide: (label: string) => `Hide ${label}`,
  hiding: (names: string, duration: string) => `hiding ${names}: ${duration}`,
  showAll: 'Show all',
} as const;

interface Group {
  label: string;
  /** Engine origin ids the chip toggles together. */
  origins: readonly number[];
  /** Origin whose color and pattern the chip carries. */
  look: number;
}

export const ORIGIN_GROUPS: readonly Group[] = [
  { label: 'Your code', origins: [0], look: 0 },
  { label: 'Dependencies', origins: [1], look: 1 },
  { label: 'Framework', origins: [2], look: 2 },
  { label: 'Node internals', origins: [3], look: 3 },
  { label: 'Native', origins: [4], look: 4 },
  { label: 'GC & idle', origins: [5, 6], look: 6 },
];

/** Toggle a group in the list of hidden origins. */
export function toggleGroup(hidden: readonly number[], group: Group): number[] {
  const hiding = group.origins.every((o) => hidden.includes(o));
  return hiding
    ? hidden.filter((o) => !group.origins.includes(o))
    : [...new Set([...hidden, ...group.origins])].sort((a, b) => a - b);
}

/**
 * The shared "Show" filter: origin chips for the waterfall, flame graph, call graph and functions
 * table. Hiding an origin merges its frames into their caller (the engine's `hide-origins`), so
 * numbers re-aggregate rather than disappear; the summary says what is hidden and for how long.
 */
export function FilterBar() {
  const { client, scope, scopeKey, snap, dispatch } = useApp();
  const hidden = snap.options.hide;
  const set = (hide: number[]): void => dispatch({ type: 'options', options: { hide } });
  const hiddenQ = useAsync(() => client.hidden(scope), `hidden:${scopeKey}`);
  const parts = hidden.length === 0 ? [] : (hiddenQ.data ?? []);
  const names = ORIGIN_GROUPS.filter((g) => g.origins.every((o) => hidden.includes(o))).map(
    (g) => g.label,
  );
  const hiddenUs = parts.reduce((sum, p) => sum + p.selfUs, 0);

  return (
    <div className="filter-bar" role="group" aria-label={TEXT.show}>
      <span className="caps">{TEXT.show}</span>
      {ORIGIN_GROUPS.map((g) => {
        const off = g.origins.every((o) => hidden.includes(o));
        const info = originInfo(g.look);
        return (
          <button
            key={g.label}
            type="button"
            className={`filter-chip${off ? ' is-off' : ''}`}
            aria-pressed={!off}
            title={off ? TEXT.hidden(g.label) : TEXT.hide(g.label)}
            onClick={() => set(toggleGroup(hidden, g))}
          >
            <span
              className={`filter-swatch pattern-${info.pattern}`}
              style={{ background: `var(${g.look === 0 ? info.solid : info.dim})` }}
              aria-hidden="true"
            >
              {info.glyph}
            </span>
            {g.label}
          </button>
        );
      })}
      {hidden.length > 0 ? (
        <span className="filter-summary" role="status">
          {TEXT.hiding(names.join(', '), fmtDuration(hiddenUs))}
          <button type="button" className="filter-reset" onClick={() => set([])}>
            {TEXT.showAll}
          </button>
        </span>
      ) : null}
    </div>
  );
}
