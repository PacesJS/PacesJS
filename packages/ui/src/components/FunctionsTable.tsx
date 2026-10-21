import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../app/context';
import { useAsync } from '../app/hooks';
import type { FnRow } from '../data/types';
import { fmtRange, fmtSeconds } from '../util/format';
import { FunctionRow } from './FunctionRow';
import { Hint } from './Hint';
import { HotPaths } from './HotPaths';
import { Legend } from './Legend';
import { Sandwich } from './Sandwich';
import { Switch } from './Switch';

type SortKey = 'name' | 'origin' | 'self' | 'total' | 'share' | 'calls' | 'loc';

const TEXT = {
  columns: {
    name: 'Function',
    origin: 'Origin',
    self: 'Self',
    total: 'Total',
    share: 'Share',
    calls: 'Calls est.',
    loc: 'Location',
  },
  loading: 'Loading functions…',
  allTracks: 'all tracks',
  rangeSuffix: (range: string, duration: string, track: string) =>
    ` · range ${range} (${duration} on ${track})`,
  filterLabel: 'Filter functions by name, file or package',
  filterPlaceholder: 'Filter by name, file or package',
  yourCodeFirst: 'Your code first',
  targetOnly: 'Target only',
  package: 'Package',
  allPackages: 'All packages',
  highToLow: 'high to low',
  lowToHigh: 'low to high',
  status: (count: number, sortedBy: string, direction: string) =>
    `${count} functions · sorted by ${sortedBy} · ${direction}`,
  hint: 'Each row is one function, with its own time (self) and the time of everything it called (total). Select a row to see its callers and callees below.',
  table: (sortedBy: string) => `Functions, sorted by ${sortedBy}`,
  selfSorted: (direction: string) => `Self, ${direction}`,
  yourCode: (count: number) => `Your code · ${count}`,
  others: (shown: number, total: number) => `Dependencies, Node and native · ${shown} of ${total}`,
  packagesCollapsed: ' · packages collapsed',
  showFewer: 'Show fewer',
  showAll: (count: number) => `Show all ${count}`,
  selectSandwich: 'Select a function to open its sandwich: callers above, callees below.',
} as const;

const COLUMNS: Array<{ key: SortKey; label: string; align?: 'right' }> = [
  { key: 'name', label: TEXT.columns.name },
  { key: 'origin', label: TEXT.columns.origin },
  { key: 'self', label: TEXT.columns.self, align: 'right' },
  { key: 'total', label: TEXT.columns.total, align: 'right' },
  { key: 'share', label: TEXT.columns.share, align: 'right' },
  { key: 'calls', label: TEXT.columns.calls, align: 'right' },
  { key: 'loc', label: TEXT.columns.loc },
];

function value(r: FnRow, key: SortKey): number | string {
  switch (key) {
    case 'name':
      return r.name.toLowerCase();
    case 'origin':
      return r.origin;
    case 'self':
      return r.selfUs;
    case 'total':
      return r.totalUs;
    case 'share':
      return r.share;
    case 'calls':
      return r.calls;
    case 'loc':
      return r.loc;
  }
}

function sortRows(rows: FnRow[], key: SortKey, dir: 'asc' | 'desc'): FnRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const va = value(a, key);
    const vb = value(b, key);
    const c =
      typeof va === 'string' ? va.localeCompare(vb as string) : (va as number) - (vb as number);
    return c * sign || b.selfUs - a.selfUs || a.name.localeCompare(b.name);
  });
}

const OTHER_CAP = 25;

export function FunctionsTable() {
  const { client, scope, scopeKey, snap, dispatch, state, selection, summary, openDock } = useApp();
  const { fnPkg, targetOnly } = snap.options;
  const q = useAsync(
    () =>
      client.functions(scope, state.search, {
        ...(targetOnly ? { origins: [0] } : {}),
        ...(fnPkg ? { pkg: fnPkg } : {}),
      }),
    `functions:${scopeKey}:${state.search}:${targetOnly}:${fnPkg}`,
  );
  const selectFn = useCallback(
    (fn: number) => dispatch({ type: 'select', selection: { kind: 'fn', fn } }),
    [dispatch],
  );
  const hoverFn = useCallback(
    (fn: number | null) =>
      dispatch({ type: 'hover', selection: fn === null ? { kind: 'none' } : { kind: 'fn', fn } }),
    [dispatch],
  );
  const [userFirst, setUserFirst] = useState(true);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'self',
    dir: 'desc',
  });
  const [showAll, setShowAll] = useState(false);
  const selectedRef = useRef<HTMLDivElement | null>(null);
  const data = q.data;
  const selectedFn = selection.fn;
  // Bring the selected row into view when the selection changes (Show me, other views), but do
  // not scroll the page on the first paint: opening a session starts at the top.
  const shownFn = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (!data) return;
    if (shownFn.current !== undefined && shownFn.current !== selectedFn) {
      selectedRef.current?.scrollIntoView({ block: 'nearest' });
    }
    shownFn.current = selectedFn;
  }, [selectedFn, data]);
  const rows = useMemo(() => (data ? sortRows(data.rows, sort.key, sort.dir) : []), [data, sort]);
  if (q.error)
    return (
      <div className="wf-empty" role="alert">
        {q.error}
      </div>
    );
  if (!data)
    return (
      <div className="wf-empty" role="status">
        {TEXT.loading}
      </div>
    );

  const mine = userFirst ? rows.filter((r) => r.origin === 0) : rows;
  const others = userFirst ? rows.filter((r) => r.origin !== 0) : [];
  const capped = others.slice(0, OTHER_CAP);
  const pinned = others.find((r) => r.fn === selection.fn);
  // The selected function stays visible even when it is below the cap.
  const shownOthers = showAll
    ? others
    : pinned && !capped.includes(pinned)
      ? [...capped, pinned]
      : capped;
  const maxSelf = Math.max(1, ...rows.map((r) => r.selfUs));
  const selectedRow = rows.find((r) => r.fn === selection.fn) ?? null;
  const sortLabel =
    COLUMNS.find((c) => c.key === sort.key)?.label.toLowerCase() ?? TEXT.columns.self.toLowerCase();
  const rangeSuffix = snap.range
    ? TEXT.rangeSuffix(
        fmtRange(snap.range[0], snap.range[1]),
        fmtSeconds(snap.range[1] - snap.range[0], 2),
        snap.track === 'all' ? TEXT.allTracks : snap.track,
      )
    : '';

  const renderRow = (r: FnRow) => (
    <FunctionRow
      key={r.fn}
      r={r}
      maxSelf={maxSelf}
      selected={selection.fn === r.fn}
      selectedRef={selectedRef}
      onSelect={selectFn}
      onOpen={openDock}
      onHover={hoverFn}
    />
  );

  return (
    <>
      <div className="toolbar" style={{ gap: '12px 16px' }}>
        <div className="fn-filter">
          <label htmlFor="fn-filter" className="sr-only">
            {TEXT.filterLabel}
          </label>
          <span className="search-icon" aria-hidden="true">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
          </span>
          <input
            id="fn-filter"
            type="search"
            className="fn-filter-input"
            placeholder={TEXT.filterPlaceholder}
            value={state.search}
            onChange={(e) => dispatch({ type: 'search', text: e.target.value })}
          />
        </div>
        <Switch checked={userFirst} onChange={setUserFirst}>
          {TEXT.yourCodeFirst}
        </Switch>
        <Switch
          checked={targetOnly}
          onChange={(v) => dispatch({ type: 'options', options: { targetOnly: v } })}
        >
          {TEXT.targetOnly}
        </Switch>
        <div className="field">
          <label htmlFor="fn-pkg">{TEXT.package}</label>
          <select
            id="fn-pkg"
            className="select"
            value={fnPkg}
            onChange={(e) => dispatch({ type: 'options', options: { fnPkg: e.target.value } })}
          >
            <option value="">{TEXT.allPackages}</option>
            {summary.packages.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <span className="fn-status" role="status">
          {TEXT.status(
            data.totalFns,
            sortLabel,
            sort.dir === 'desc' ? TEXT.highToLow : TEXT.lowToHigh,
          )}
          {rangeSuffix}
        </span>
      </div>
      <Legend />
      <HotPaths />
      <Hint id="hint-functions">{TEXT.hint}</Hint>
      <div className="fn-scroll">
        <div role="table" aria-label={TEXT.table(sortLabel)} className="fn-table">
          <div role="row" className="fn-row fn-head">
            {COLUMNS.map((c) => (
              <span
                key={c.key}
                role="columnheader"
                aria-sort={
                  sort.key === c.key
                    ? sort.dir === 'desc'
                      ? 'descending'
                      : 'ascending'
                    : undefined
                }
                style={{ textAlign: c.align }}
              >
                <button
                  type="button"
                  style={{ textAlign: c.align ?? 'left' }}
                  onClick={() =>
                    setSort((s) => ({
                      key: c.key,
                      dir: s.key === c.key && s.dir === 'desc' ? 'asc' : 'desc',
                    }))
                  }
                >
                  {sort.key === c.key && c.key === 'self'
                    ? TEXT.selfSorted(sort.dir === 'desc' ? TEXT.highToLow : TEXT.lowToHigh)
                    : c.label}
                </button>
              </span>
            ))}
          </div>
          {userFirst ? (
            <div
              role="row"
              className="fn-group is-user caps"
              style={{ color: 'var(--c-accent-ink)' }}
            >
              <span role="rowheader">{TEXT.yourCode(mine.length)}</span>
            </div>
          ) : null}
          {mine.slice(0, 300).map(renderRow)}
          {userFirst ? (
            <div role="row" className="fn-group caps" style={{ paddingTop: 16 }}>
              <span role="rowheader">
                {TEXT.others(shownOthers.length, others.length)}
                {snap.transforms.some((t) => t.k === 'collapse-deps') ? TEXT.packagesCollapsed : ''}
              </span>
            </div>
          ) : null}
          {shownOthers.map(renderRow)}
        </div>
      </div>
      {userFirst && others.length > OTHER_CAP ? (
        <button
          type="button"
          className="btn btn-sm"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? TEXT.showFewer : TEXT.showAll(others.length)}
        </button>
      ) : null}
      {selectedRow ? (
        <Sandwich fn={selectedRow.fn} name={selectedRow.name} totalUs={selectedRow.totalUs} />
      ) : (
        <p className="section-sub" role="status">
          {TEXT.selectSandwich}
        </p>
      )}
    </>
  );
}
