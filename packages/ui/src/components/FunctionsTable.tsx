import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../app/context';
import { useAsync } from '../app/hooks';
import type { FnRow } from '../data/types';
import { originColor, originInfo } from '../theme/origin';
import { fmtCount, fmtDuration, fmtRange, fmtShare } from '../util/format';
import { Hint } from './Hint';
import { HotPaths } from './HotPaths';
import { Legend } from './Legend';
import { Sandwich } from './Sandwich';
import { Switch } from './Switch';

type SortKey = 'name' | 'origin' | 'self' | 'total' | 'share' | 'calls' | 'loc';

const COLUMNS: Array<{ key: SortKey; label: string; align?: 'right' }> = [
  { key: 'name', label: 'Function' },
  { key: 'origin', label: 'Origin' },
  { key: 'self', label: 'Self', align: 'right' },
  { key: 'total', label: 'Total', align: 'right' },
  { key: 'share', label: 'Share', align: 'right' },
  { key: 'calls', label: 'Calls est.', align: 'right' },
  { key: 'loc', label: 'Location' },
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
  const { client, scope, scopeKey, snap, dispatch, state, selection, hoverFn, summary, openDock } =
    useApp();
  const { fnPkg, targetOnly } = snap.options;
  const q = useAsync(
    () =>
      client.functions(scope, state.search, {
        ...(targetOnly ? { origins: [0] } : {}),
        ...(fnPkg ? { pkg: fnPkg } : {}),
      }),
    `functions:${scopeKey}:${state.search}:${targetOnly}:${fnPkg}`,
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
        Loading functions…
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
  const sortLabel = COLUMNS.find((c) => c.key === sort.key)?.label.toLowerCase() ?? 'self';
  const rangeSuffix = snap.range
    ? ` · range ${fmtRange(snap.range[0], snap.range[1])} (${((snap.range[1] - snap.range[0]) / 1_000_000).toFixed(2)} s on ${snap.track === 'all' ? 'all tracks' : snap.track})`
    : '';

  const renderRow = (r: FnRow) => {
    const selected = selection.fn === r.fn;
    const hovered = hoverFn === r.fn;
    return (
      <div
        key={r.fn}
        ref={selected ? selectedRef : undefined}
        role="row"
        aria-selected={selected}
        tabIndex={0}
        className={`fn-row${selected ? ' is-selected' : ''}${hovered ? ' is-hover' : ''}`}
        onClick={() => dispatch({ type: 'select', selection: { kind: 'fn', fn: r.fn } })}
        onDoubleClick={() => openDock()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            dispatch({ type: 'select', selection: { kind: 'fn', fn: r.fn } });
          }
        }}
        onPointerEnter={() => dispatch({ type: 'hover', selection: { kind: 'fn', fn: r.fn } })}
        onPointerLeave={() => dispatch({ type: 'hover', selection: { kind: 'none' } })}
      >
        <span role="cell" className="fn-cell fn-cell-name">
          <span
            className="wf-dot"
            aria-hidden="true"
            style={{ background: originColor(r.origin, false) }}
          />
          <span className={`fn-name${r.origin === 0 ? ' is-user' : ''}`}>{r.name}</span>
        </span>
        <span role="cell" className="fn-cell fn-cell-origin">
          {originInfo(r.origin).label}
        </span>
        <span role="cell" className="fn-cell fn-cell-self">
          <span className="fn-bar" aria-hidden="true">
            <span
              className="fn-bar-fill"
              style={{
                width: `${Math.max(3, (r.selfUs / maxSelf) * 100)}%`,
                background: originColor(r.origin),
              }}
            />
          </span>
          <span className="num" style={{ fontWeight: 600 }}>
            {fmtDuration(r.selfUs)}
          </span>
        </span>
        <span role="cell" className="fn-cell fn-cell-num">
          {fmtDuration(r.totalUs)}
        </span>
        <span role="cell" className="fn-cell fn-cell-num">
          {fmtShare(r.share)}
        </span>
        <span role="cell" className="fn-cell fn-cell-calls">
          {r.calls > 0 ? fmtCount(r.calls) : '—'}
        </span>
        <span role="cell" className="fn-cell fn-cell-loc" title={r.loc}>
          {r.loc}
        </span>
      </div>
    );
  };

  return (
    <>
      <div className="toolbar" style={{ gap: '12px 16px' }}>
        <div className="fn-filter">
          <label htmlFor="fn-filter" className="sr-only">
            Filter functions by name, file or package
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
            placeholder="Filter by name, file or package"
            value={state.search}
            onChange={(e) => dispatch({ type: 'search', text: e.target.value })}
          />
        </div>
        <Switch checked={userFirst} onChange={setUserFirst}>
          Your code first
        </Switch>
        <Switch
          checked={targetOnly}
          onChange={(v) => dispatch({ type: 'options', options: { targetOnly: v } })}
        >
          Target only
        </Switch>
        <div className="field">
          <label htmlFor="fn-pkg">Package</label>
          <select
            id="fn-pkg"
            className="select"
            value={fnPkg}
            onChange={(e) => dispatch({ type: 'options', options: { fnPkg: e.target.value } })}
          >
            <option value="">All packages</option>
            {summary.packages.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <span className="fn-status" role="status">
          {data.totalFns} functions · sorted by {sortLabel} ·{' '}
          {sort.dir === 'desc' ? 'high to low' : 'low to high'}
          {rangeSuffix}
        </span>
      </div>
      <Legend />
      <HotPaths />
      <Hint id="hint-functions">
        Each row is one function, with its own time (self) and the time of everything it called
        (total). Select a row to see its callers and callees below.
      </Hint>
      <div className="fn-scroll">
        <div role="table" aria-label={`Functions, sorted by ${sortLabel}`} className="fn-table">
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
                    ? `Self, ${sort.dir === 'desc' ? 'high to low' : 'low to high'}`
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
              <span role="rowheader">Your code · {mine.length}</span>
            </div>
          ) : null}
          {mine.slice(0, 300).map(renderRow)}
          {userFirst ? (
            <div role="row" className="fn-group caps" style={{ paddingTop: 16 }}>
              <span role="rowheader">
                Dependencies, Node and native · {shownOthers.length} of {others.length}
                {snap.transforms.some((t) => t.k === 'collapse-deps')
                  ? ' · packages collapsed'
                  : ''}
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
          {showAll ? 'Show fewer' : `Show all ${others.length}`}
        </button>
      ) : null}
      {selectedRow ? (
        <Sandwich fn={selectedRow.fn} name={selectedRow.name} totalUs={selectedRow.totalUs} />
      ) : (
        <p className="section-sub" role="status">
          Select a function to open its sandwich: callers above, callees below.
        </p>
      )}
    </>
  );
}
