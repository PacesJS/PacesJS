import {
  ORIGIN_NAMES,
  Origin,
  applyTransforms,
  buildAgentSummary,
  callTreeQuery,
  callersOf,
  describeTasks,
  functionRows,
  functionSource,
  resolveSelector,
  share,
} from '@pacesjs/engine';
import type {
  CallerNode,
  ExecutionModel,
  FnId,
  OriginId,
  SelectorResult,
  Transform,
  TreeResult,
  TreeRow,
  TreeSelector,
} from '@pacesjs/engine';
import type { Flags } from '../args.js';
import { fnFacts, originName } from '../fn-facts.js';
import type { SourceResolver } from '../source-resolver.js';
import {
  fmtPct,
  fmtUs,
  orAnon,
  padEnd,
  padStart,
  painter,
  pctCol,
  place,
  shellArg,
  shortPath,
  timeCol,
  truncate,
} from './format.js';
import type { Painter } from './format.js';

const REPORT_SCHEMA_VERSION = 1;

export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportError';
  }
}

export interface ReportContext {
  model: ExecutionModel;
  /** Session file, as it should appear in the next: commands. */
  file: string;
  resolver?: SourceResolver;
  color: boolean;
}

export interface ReportOutput {
  text: string;
  json: unknown;
}

const NAME_WIDTH = 58;
const DEFAULT_MAX_LINES = 60;
/** Lines a tree view spends besides rows: title, header, footer, "next:" and up to three commands. */
const TREE_FIXED_LINES = 8;

/** Rows a view may print: `--max-lines` minus the lines it spends on title, header and footer. */
function lineBudget(flags: Flags, reserved: number, floor = 3): number {
  return Math.max(floor, (flags.report.maxLines ?? DEFAULT_MAX_LINES) - reserved);
}

/** `--limit` (or the view's default), held to what fits in the line budget. */
function cappedLimit(flags: Flags, fallback: number, reserved: number, floor = 3): number {
  return Math.min(flags.report.limit ?? fallback, lineBudget(flags, reserved, floor));
}

const round = (n: number): number => Math.round(n * 10) / 10;

function trackIndexOf(model: ExecutionModel, wanted: string | undefined): number {
  if (wanted === undefined || wanted === 'primary') return model.primaryTrack;
  const byId = model.tracks.findIndex((t) => t.id === wanted);
  if (byId >= 0) return byId;
  const n = Number(wanted);
  if (Number.isInteger(n) && n >= 0 && n < model.tracks.length) return n;
  const ids = model.tracks.map((t, i) => `${t.id} (#${i}, ${t.label})`).join('; ');
  throw new ReportError(`No track "${wanted}". Tracks: ${ids}. Use --track <id|number|primary>.`);
}

function taskOf(flags: Flags): number | 'whole' {
  const t = flags.report.task;
  return t === undefined || t === 'whole' ? 'whole' : Number(t);
}

/** The UI's stack minus dependency collapsing, so every function is visible. */
function plainView(model: ExecutionModel, ti: number, task: number | 'whole') {
  const stack: Transform[] = [{ kind: 'stitch-continuations' }];
  if (task !== 'whole') {
    const tasks = model.tracks[ti]?.tasks;
    if (!tasks || task < 0 || task >= tasks.length) {
      throw new ReportError(`No task ${task} on this track. List them with --tasks.`);
    }
    stack.push({ kind: 'time-range', start: tasks.start[task] ?? 0, end: tasks.end[task] ?? 0 });
  }
  stack.push({ kind: 'merge-plumbing' }, { kind: 'drop-idle' });
  return applyTransforms(model, ti, stack);
}

function originsOf(flags: Flags): OriginId[] | undefined {
  const o = flags.report.origin;
  if (!o) return undefined;
  return o.map((n) => ORIGIN_NAMES.indexOf(n as (typeof ORIGIN_NAMES)[number]) as OriginId);
}

const locate = (model: ExecutionModel, fn: FnId) => fnFacts(model, fn, true);

function tag(origin: number, pkg: string, synthetic = false): string {
  if (synthetic) return '(collapsed)';
  if (origin === Origin.User) return '';
  if (origin === Origin.Dependency || origin === Origin.Framework)
    return pkg ? `(${pkg})` : `(${originName(origin)})`;
  return `(${originName(origin)})`;
}

const HOW_PHRASE: Partial<Record<SelectorResult['how'], string>> = {
  substring: 'by substring',
  path: 'by name path',
  location: 'by file:line',
  id: 'by id',
};

const describeHow = (how: SelectorResult['how']): string => HOW_PHRASE[how] ?? 'exactly';

/** One function out of a selector, or a clear error listing the candidates. */
function pick(
  ctx: ReportContext,
  ti: number,
  text: string,
): { selector: TreeSelector; fn: FnId; note: string } {
  const { model } = ctx;
  const r = resolveSelector(model, ti, text);
  if (r.matches.length === 0) {
    throw new ReportError(
      `No function matches "${text}" on this track. Try a function name, "a,b,c" (a path), file.js:123, or an id from earlier output (f123). Find names with: paces report ${shellArg(ctx.file)} --top self`,
    );
  }
  const first = r.matches[0] as SelectorResult['matches'][number];
  if (r.matches.length > 1 && r.how !== 'id') {
    const lines = r.matches.slice(0, 8).map((m) => {
      const l = locate(model, m.fn);
      return `  f${m.fn}  ${orAnon(l.name)}  ${place(l.file, l.line)}  total ${fmtUs(m.totalUs)}`;
    });
    const more = r.matches.length > 8 ? `\n  … and ${r.matches.length - 8} more` : '';
    throw new ReportError(
      `"${text}" is ambiguous: it matched ${r.matches.length} functions ${describeHow(r.how)}:\n${lines.join('\n')}${more}\nPick one by id (e.g. f${first.fn}), by file:line, or with a path like parent,${text}.`,
    );
  }
  return {
    selector: { fn: first.fn, ...(first.path ? { path: first.path } : {}) },
    fn: first.fn,
    note: r.how === 'substring' ? `matched "${text}" by substring (1 function)` : '',
  };
}

interface Header {
  lines: string[];
  json: Record<string, unknown>;
}

/** The JSON every view shares: schema version, view name and header, then the view's own fields. */
function envelope(
  view: string,
  head: Header,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return { schemaVersion: REPORT_SCHEMA_VERSION, view, ...head.json, ...body };
}

/** Closes a view: the `next:` commands end the text and the JSON. */
function finishView(
  view: string,
  head: Header,
  lines: string[],
  next: string[],
  body: Record<string, unknown>,
): ReportOutput {
  return {
    text: [...lines, 'next:', ...next].join('\n'),
    json: { ...envelope(view, head, body), next: next.map((n) => n.trim()) },
  };
}

function headerOf(ctx: ReportContext, ti: number, flags: Flags, title: string): Header {
  const { model } = ctx;
  const track = model.tracks[ti];
  const t = model.target;
  const target = t.packages.length > 0 ? t.packages.join(', ') : shortPath(t.entry);
  const busy = track?.busyUs ?? 0;
  const dur = model.meta.durationUs;
  const prec = model.meta.precisionUs;
  const task = taskOf(flags);
  const lines = [
    title,
    `${model.meta.runKind} · ${target} · entry ${shortPath(t.entry)} · track ${track?.label ?? '?'} · ${fmtUs(dur).replace('~', '')} run, ${fmtUs(busy)} busy · ±${fmtUs(prec).replace('~', '')} (~ = sampled)${task === 'whole' ? '' : ` · task ${task}`}`,
  ];
  return {
    lines,
    json: {
      runKind: model.meta.runKind,
      target: t,
      track: { index: ti, id: track?.id, label: track?.label },
      durationMs: round(dur / 1000),
      busyMs: round(busy / 1000),
      precisionMs: round(prec / 1000),
      task,
    },
  };
}

interface Layout {
  left: string;
  nums: string;
  where: string;
}

function renderRows(rows: Layout[], paint: Painter): string[] {
  const width = Math.min(NAME_WIDTH + 12, Math.max(0, ...rows.map((r) => r.left.length)));
  return rows.map(
    (r) =>
      `${padEnd(truncate(r.left, width), width)}  ${r.nums}${r.where ? `  ${paint.dim(r.where)}` : ''}`,
  );
}

function treeLayout(row: TreeRow): Layout {
  const indent = '  '.repeat(row.depth);
  const name = row.synthetic ? `▸ ${row.name}` : `${orAnon(row.name)}`;
  const id = row.synthetic ? '' : ` [${row.id}]`;
  const t = tag(row.origin, row.pkg, row.synthetic);
  return {
    left: `${indent}${truncate(name, NAME_WIDTH)}${id}${t ? ` ${t}` : ''}`,
    nums: `${timeCol(row.totalUs)} ${pctCol(row.share)}  self ${timeCol(row.selfUs)}`,
    where: place(row.file, row.line),
  };
}

function nextCmd(ctx: ReportContext, args: string): string {
  return `  paces report ${shellArg(ctx.file)} ${args}`;
}

/**
 * Follows single-child chains (each child carries at least 90% of its parent) down to the function
 * where the time forks, so one drill-down command lands on something informative.
 */
function forkOf(ctx: ReportContext, ti: number, start: TreeRow): TreeRow {
  const res = callTreeQuery(ctx.model, ti, {
    from: { fn: start.fn },
    depth: 40,
    minShare: 0.02,
    maxRows: 600,
  });
  const rows = res.rows;
  let at = 0;
  for (;;) {
    const row = rows[at];
    if (!row) break;
    const kids: number[] = [];
    for (let j = at + 1; j < rows.length && (rows[j]?.depth ?? 0) > row.depth; j++) {
      if (rows[j]?.depth === row.depth + 1) kids.push(j);
    }
    const only = kids.length === 1 ? rows[kids[0] as number] : undefined;
    if (only && !only.synthetic && only.totalUs >= 0.9 * row.totalUs) at = kids[0] as number;
    else break;
  }
  return rows[at] ?? start;
}

/** 1-3 concrete commands: the heaviest child to drill into, the hottest function's lines, its callers. */
function nextForTree(ctx: ReportContext, rows: TreeRow[], ti: number): string[] {
  const out: string[] = [];
  const real = rows.filter((r) => !r.synthetic);
  // Prefer descending through the target's own code (not runtime entry glue) over runtime or package rows.
  const own = real
    .filter(
      (r) =>
        r.depth >= 1 &&
        r.origin === Origin.User &&
        !r.name.startsWith('require ▸') &&
        !r.name.startsWith('import ▸'),
    )
    .sort((a, b) => b.totalUs - a.totalUs || a.depth - b.depth)[0];
  const child =
    own ??
    rows.filter((r) => r.depth === 1 && !r.synthetic).sort((a, b) => b.totalUs - a.totalUs)[0] ??
    real.filter((r) => r.depth > 0).sort((a, b) => b.totalUs - a.totalUs)[0];
  if (child) out.push(nextCmd(ctx, `--tree --from ${forkOf(ctx, ti, child).id}`));
  // Source lines only make sense for code that has source: the target's own functions first, then
  // any function with a source file. Never GC, idle or runtime glue.
  const bySelf = (a: TreeRow, b: TreeRow): number => b.selfUs - a.selfUs;
  const hot =
    [...real].filter((r) => r.origin === Origin.User && r.selfUs > 0).sort(bySelf)[0] ??
    [...real]
      .filter((r) => r.file && r.origin !== Origin.Idle && r.origin !== Origin.Gc)
      .sort(bySelf)[0];
  if (hot && hot.selfUs > 0) out.push(nextCmd(ctx, `--lines ${hot.id}`));
  // A collapsed package that only passes control through to the target's code (a retry or
  // scheduling wrapper) is not where the time goes; suggest a package that does work itself.
  const passesThrough = (r: TreeRow): boolean => {
    const at = rows.indexOf(r);
    const next = rows[at + 1];
    return next !== undefined && next.depth > r.depth && next.origin === Origin.User;
  };
  const pkg = rows
    .filter((r) => r.synthetic && !passesThrough(r))
    .sort((a, b) => b.totalUs - a.totalUs)[0];
  if (pkg && pkg.share >= 0.05) out.push(nextCmd(ctx, `--pkg ${shellArg(pkg.pkg)}`));
  else if (hot && hot.selfUs > 0) out.push(nextCmd(ctx, `--callers ${hot.id}`));
  return out.slice(0, 3);
}

function footerFor(res: TreeResult): string[] {
  if (res.hidden <= 0) return [];
  const drill =
    [...res.rows].filter((r) => r.folded).sort((a, b) => b.totalUs - a.totalUs)[0] ?? res.rows[0];
  return [
    `… ${res.hidden} more rows (raise --depth, lower --min-share, or drill with --from ${drill?.id ?? 'fNNN'})`,
  ];
}

function treeOptions(flags: Flags, selector?: TreeSelector) {
  const r = flags.report;
  const budget = lineBudget(flags, TREE_FIXED_LINES);
  const origins = originsOf(flags);
  return {
    ...(selector ? { from: selector } : {}),
    depth: r.depth ?? 6,
    ...(r.minMs !== undefined ? { minUs: r.minMs * 1000 } : {}),
    ...(r.minShare !== undefined ? { minShare: r.minShare } : {}),
    sort: r.sort ?? 'total',
    ...(origins ? { origins } : {}),
    expandPkgs: [...r.expand, ...(r.tree && r.pkg ? [r.pkg] : [])],
    collapseDeps: !r.noCollapse,
    task: taskOf(flags),
    maxRows: flags.json ? Math.max(budget, 200) : budget,
  };
}

function jsonRow(row: TreeRow): Record<string, unknown> {
  return {
    id: row.id,
    depth: row.depth,
    name: row.name,
    package: row.pkg,
    origin: originName(row.origin),
    file: row.file,
    line: row.line,
    totalMs: round(row.totalUs / 1000),
    selfMs: round(row.selfUs / 1000),
    share: share(row.share),
    collapsed: row.synthetic,
    ...(row.folded ? { folded: row.folded } : {}),
  };
}

function treeView(
  ctx: ReportContext,
  flags: Flags,
  ti: number,
  title: string,
  selector?: TreeSelector,
  note = '',
): ReportOutput {
  const paint = painter(ctx.color);
  const head = headerOf(ctx, ti, flags, title);
  const res = callTreeQuery(ctx.model, ti, treeOptions(flags, selector));
  if (res.rows.length === 0) {
    throw new ReportError('Nothing to show: the selection has no samples in this track or task.');
  }
  const rows = res.rows;
  const lines = [
    ...head.lines,
    ...(note ? [note] : []),
    ...renderRows(rows.map(treeLayout), paint),
  ];
  lines.push(...footerFor(res));
  return finishView('tree', head, lines, nextForTree(ctx, rows, ti), {
    rootMs: round(res.rootUs / 1000),
    hiddenRows: res.hidden,
    rows: rows.map(jsonRow),
  });
}

function flattenCallers(
  nodes: CallerNode[],
  depth: number,
  out: Array<{ node: CallerNode; depth: number }>,
): void {
  for (const n of nodes) {
    out.push({ node: n, depth });
    flattenCallers(n.callers, depth + 1, out);
  }
}

function callersView(ctx: ReportContext, flags: Flags, ti: number): ReportOutput {
  const paint = painter(ctx.color);
  const text = flags.report.callers as string;
  const { fn, note } = pick(ctx, ti, text);
  const { model } = ctx;
  const target = locate(model, fn);
  const track = model.tracks[ti];
  const slot = track ? Array.from(track.fnIds).indexOf(fn) : -1;
  const total = track?.agg.fnTotal[slot] ?? 0;
  const calls = track?.agg.fnCalls[slot] ?? 0;
  const depth = flags.report.depth ?? 3;
  const flat: Array<{ node: CallerNode; depth: number }> = [];
  flattenCallers(callersOf(model, ti, fn, depth), 0, flat);
  const head = headerOf(
    ctx,
    ti,
    flags,
    `callers of ${orAnon(target.name)} [f${fn}] · total ${fmtUs(total)} · ~${calls} calls · ${place(target.file, target.line)}`,
  );
  if (flat.length === 0) {
    return {
      text: [
        ...head.lines,
        'No callers recorded (it is a top-level entry, or called only from runtime frames).',
      ].join('\n'),
      json: envelope('callers', head, { rows: [] }),
    };
  }
  const budget = lineBudget(flags, 7);
  const shown = flat.slice(0, budget);
  const layout = shown.map(({ node, depth: d }): Layout => {
    const l = locate(model, node.fn);
    const t = tag(l.origin, l.pkg);
    return {
      left: `${'  '.repeat(d)}${truncate(orAnon(node.name), NAME_WIDTH)} [f${node.fn}]${t ? ` ${t}` : ''}`,
      nums: `via ${timeCol(node.weightUs)} ${padStart(d === 0 ? fmtPct(total > 0 ? node.weightUs / total : 0) : '', 5)}  ~${node.calls} calls`,
      where: place(node.file, node.line),
    };
  });
  const lines = [...head.lines, ...(note ? [note] : []), ...renderRows(layout, paint)];
  if (flat.length > shown.length) {
    lines.push(
      `… ${flat.length - shown.length} more rows (lower --depth, or drill with --callers f${shown.at(-1)?.node.fn})`,
    );
  }
  const top = shown.find((s) => s.depth === 0)?.node;
  const next = [
    ...(top
      ? [
          nextCmd(ctx, `--callers f${top.fn} --depth ${depth}`),
          nextCmd(ctx, `--tree --from f${top.fn}`),
        ]
      : []),
    nextCmd(ctx, `--lines f${fn}`),
  ].slice(0, 3);
  return finishView('callers', head, lines, next, {
    function: {
      id: `f${fn}`,
      name: target.name,
      file: target.file,
      line: target.line,
      totalMs: round(total / 1000),
      calls,
    },
    rows: flat.map(({ node, depth: d }) => ({
      depth: d,
      id: `f${node.fn}`,
      name: node.name,
      file: node.file,
      line: node.line,
      viaMs: round(node.weightUs / 1000),
      calls: node.calls,
    })),
  });
}

function topView(ctx: ReportContext, flags: Flags, ti: number, pkg?: string): ReportOutput {
  const paint = painter(ctx.color);
  const { model } = ctx;
  const sort = flags.report.top ?? (flags.report.sort === 'total' ? 'total' : 'self');
  const view = plainView(model, ti, taskOf(flags));
  const origins = originsOf(flags);
  const rows = functionRows(model, view, {
    sort,
    userFirst: false,
    ...(origins ? { origins } : {}),
    ...(pkg ? { pkg } : {}),
  });
  if (pkg && rows.length === 0) {
    const names = Array.from(
      { length: Math.min(model.packages.length, 8) },
      (_, i) => model.strings[model.packages.name[i] ?? 0],
    ).join(', ');
    throw new ReportError(`No package "${pkg}" on this track. Biggest packages: ${names}.`);
  }
  const limit = cappedLimit(flags, 15, 7);
  const shown = rows.slice(0, limit);
  const title = pkg ? `package ${pkg}: functions by ${sort} time` : `top functions by ${sort} time`;
  const head = headerOf(ctx, ti, flags, title);
  const pkgTotal = pkg ? rows.reduce((n, r) => n + r.self, 0) : 0;
  const extra = pkg
    ? [
        `${pkg}: ${rows.length} functions, self ${fmtUs(pkgTotal)} (${fmtPct(pkgTotal / (view.totalUs || 1))} of the view)`,
      ]
    : [];
  const layout = shown.map((r): Layout => {
    const t = tag(r.origin, r.pkg);
    return {
      left: `${truncate(orAnon(r.name), NAME_WIDTH)} [f${r.fn}]${t && !pkg ? ` ${t}` : ''}`,
      nums: `self ${timeCol(r.self)} ${pctCol(r.selfShare)}  total ${timeCol(r.total)}  ~${r.calls} calls`,
      where: place(r.file, r.line),
    };
  });
  const lines = [...head.lines, ...extra, ...renderRows(layout, paint)];
  if (rows.length > shown.length) {
    lines.push(
      `… ${rows.length - shown.length} more functions (raise --limit${pkg ? '' : ', or filter with --pkg <name> / --origin user'})`,
    );
  }
  const first = shown[0];
  const next = first
    ? [
        nextCmd(ctx, `--lines f${first.fn}`),
        nextCmd(ctx, `--callers f${first.fn}`),
        ...(pkg
          ? [nextCmd(ctx, `--tree --expand ${shellArg(pkg)}`)]
          : [nextCmd(ctx, `--top ${sort === 'self' ? 'total' : 'self'}`)]),
      ].slice(0, 3)
    : [];
  return finishView(pkg ? 'package' : 'top', head, lines, next, {
    sort,
    ...(pkg ? { package: pkg } : {}),
    totalFunctions: rows.length,
    rows: shown.map((r) => ({
      id: `f${r.fn}`,
      name: r.name,
      package: r.pkg,
      origin: originName(r.origin),
      file: r.file,
      line: r.line,
      selfMs: round(r.self / 1000),
      totalMs: round(r.total / 1000),
      selfShare: share(r.selfShare),
      calls: r.calls,
    })),
  });
}

function linesView(ctx: ReportContext, flags: Flags, ti: number): ReportOutput {
  const paint = painter(ctx.color);
  const { model } = ctx;
  const { fn, note } = pick(ctx, ti, flags.report.lines as string);
  const info = functionSource(model, plainView(model, ti, taskOf(flags)), fn);
  const where = place(info.file, info.definitionLine || info.line);
  const head = headerOf(
    ctx,
    ti,
    flags,
    `lines of ${orAnon(info.name)} [f${fn}] · self ${fmtUs(info.selfUs)}, total ${fmtUs(info.totalUs)} · ${where}`,
  );
  const out = [...head.lines, ...(note ? [note] : [])];
  const src = ctx.resolver?.resolve(info.file);
  const text = src?.exists ? src.text.split(/\r?\n/) : undefined;
  const cap = cappedLimit(flags, 40, 8, 6);
  const jsonLines: Array<Record<string, unknown>> = [];

  if (info.lines.length > 0) {
    const selfSum = info.lines.reduce((n, l) => n + l.selfUs, 0) || 1;
    const hot = info.lines
      .filter((l) => l.selfUs / selfSum >= 0.05)
      .sort((a, b) => b.selfUs - a.selfUs)
      .slice(0, 8);
    const hotSet = new Set(hot.map((l) => l.line));
    const timed = new Map(info.lines.map((l) => [l.line, l]));
    const show = new Set<number>();
    for (const l of hot) for (let d = -2; d <= 2; d++) show.add(l.line + d);
    if (info.definitionLine > 0) show.add(info.definitionLine);
    const ordered = [...show]
      .filter((n) => n >= 1 && (!text || n <= text.length))
      .sort((a, b) => a - b);
    const rows: string[] = [];
    let prev = 0;
    let shown = 0;
    for (const n of ordered) {
      if (shown >= cap) break;
      if (prev && n > prev + 1) rows.push('        …');
      const t = timed.get(n);
      const mark = hotSet.has(n) ? paint.red('▶') : ' ';
      const time = t
        ? `${timeCol(t.selfUs)} ${pctCol(t.selfUs / selfSum)}`
        : `${' '.repeat(9)} ${' '.repeat(5)}`;
      const code = text ? truncate((text[n - 1] ?? '').replace(/\t/g, '  ').trimEnd(), 110) : '';
      rows.push(`${mark} ${padStart(String(n), 5)} ${time} │ ${code}`);
      jsonLines.push({
        line: n,
        selfMs: t ? round(t.selfUs / 1000) : 0,
        share: t ? share(t.selfUs / selfSum) : 0,
        hot: hotSet.has(n),
        ...(text ? { code: text[n - 1] ?? '' } : {}),
      });
      prev = n;
      shown++;
    }
    out.push(`self time by line (share of this function's self time; ▶ = hot):`, ...rows);
    if (!text) {
      out.push(
        `(source text not available${src?.hint ? `: ${src.hint}` : ''}; line numbers are original-source lines)`,
      );
    }
    const unshown = info.lines.filter((l) => !show.has(l.line) && l.selfUs > 0).length;
    if (unshown > 0) out.push(`… ${unshown} more lines with self time below 5% each`);
  } else {
    out.push(info.lineInfo.reason || 'No per-line time for this function.');
  }
  if (info.calleeTime.length > 0) {
    out.push('callee time under this function:');
    for (const c of info.calleeTime.slice(0, 6)) {
      out.push(
        `  ${timeCol(c.totalUs)}  ${orAnon(c.name)} [f${c.fn}]${c.pkg ? ` (${c.pkg})` : ''}`,
      );
    }
  }
  const top = info.calleeTime[0];
  const next = [
    nextCmd(ctx, `--callers f${fn}`),
    nextCmd(ctx, `--tree --from f${fn}`),
    ...(top && top.totalUs > info.selfUs ? [nextCmd(ctx, `--lines f${top.fn}`)] : []),
  ].slice(0, 3);
  return finishView('lines', head, out, next, {
    function: {
      id: `f${fn}`,
      name: info.name,
      file: info.file,
      line: info.line,
      selfMs: round(info.selfUs / 1000),
      totalMs: round(info.totalUs / 1000),
    },
    sourceAvailable: Boolean(text),
    lines: jsonLines,
    calleeTime: info.calleeTime.slice(0, 6).map((c) => ({
      id: `f${c.fn}`,
      name: c.name,
      package: c.pkg,
      totalMs: round(c.totalUs / 1000),
    })),
    reason: info.lines.length === 0 ? info.lineInfo.reason : '',
  });
}

function phasesView(ctx: ReportContext, flags: Flags, ti: number): ReportOutput {
  const head = headerOf(ctx, ti, flags, 'phases of the primary track');
  const phases = buildAgentSummary(ctx.model).phases;
  const lines = [...head.lines];
  for (const p of phases) {
    lines.push(
      `${p.name}: starts ${fmtUs(p.startMs * 1000)}, lasts ${fmtUs(p.durationMs * 1000)}, busy ${fmtUs(p.busyMs * 1000)} (${fmtPct(p.share)} of busy)`,
    );
    for (const h of p.hottest.slice(0, 3)) {
      lines.push(`    ${timeCol(h.selfMs * 1000)}  ${h.name} ${place(h.file, h.line)}`);
    }
  }
  return finishView('phases', head, lines, [nextCmd(ctx, '--tree'), nextCmd(ctx, '--tasks')], {
    phases,
  });
}

function tasksView(ctx: ReportContext, flags: Flags, ti: number): ReportOutput {
  const head = headerOf(ctx, ti, flags, 'tasks (use --task <n> with --tree to drill into one)');
  const all = describeTasks(ctx.model, ti);
  const real = all.filter((t) => !t.trivial);
  const limit = cappedLimit(flags, 20, 7);
  const shown = real.slice(0, limit);
  const lines = [...head.lines];
  for (const t of shown) {
    const id = t.index < 0 ? 'whole' : String(t.index);
    lines.push(
      `[task ${padEnd(id, 5)}] ${padEnd(t.group, 9)} ${truncate(t.label, 56)}  start ${timeCol(t.startUs)}  lasts ${timeCol(t.durationUs)}  busy ${timeCol(t.busyUs)}${t.longest ? '  (longest)' : ''}`,
    );
  }
  const skipped = real.length - shown.length;
  const small = all.length - real.length;
  if (skipped > 0 || small > 0) {
    lines.push(
      `… ${skipped > 0 ? `${skipped} more tasks (raise --limit)` : ''}${skipped > 0 && small > 0 ? '; ' : ''}${small > 0 ? `${small} small tasks hidden` : ''}`,
    );
  }
  const longest = real.find((t) => t.longest) ?? real.find((t) => t.index >= 0);
  const next =
    longest && longest.index >= 0
      ? [nextCmd(ctx, `--tree --task ${longest.index}`)]
      : [nextCmd(ctx, '--tree')];
  return finishView('tasks', head, lines, next, {
    tasks: shown.map((t) => ({
      task: t.index < 0 ? 'whole' : t.index,
      group: t.group,
      label: t.label,
      startMs: round(t.startUs / 1000),
      durationMs: round(t.durationUs / 1000),
      busyMs: round(t.busyUs / 1000),
      longest: t.longest,
    })),
  });
}

function summaryView(ctx: ReportContext, flags: Flags, ti: number): ReportOutput {
  const paint = painter(ctx.color);
  const { model } = ctx;
  const s = buildAgentSummary(model);
  const head = headerOf(ctx, ti, flags, `paces report · ${model.meta.command.join(' ')}`);
  const lines = [...head.lines];
  if (s.phases.length > 0) {
    lines.push(
      `phases: ${s.phases.map((p) => `${p.name} ${fmtUs(p.durationMs * 1000)} (${fmtPct(p.share)})`).join(' · ')}`,
    );
  }
  if (s.findings.length > 0) {
    lines.push(`findings (${Math.min(3, s.findings.length)} of ${s.findings.length}):`);
    for (const f of s.findings.slice(0, 3)) {
      lines.push(`  ${f.severity.toUpperCase().padEnd(6)} ${truncate(f.summary, 150)}`);
      if (f.hint) lines.push(`         fix: ${truncate(f.hint, 200)}`);
    }
  } else lines.push('findings: none crossed a threshold');
  lines.push('where time goes:');
  const res = callTreeQuery(model, ti, {
    depth: flags.report.depth ?? 4,
    minShare: flags.report.minShare ?? 0.03,
    maxRows: 16,
    collapseDeps: !flags.report.noCollapse,
    expandPkgs: flags.report.expand,
  });
  lines.push(...renderRows(res.rows.map(treeLayout), paint).map((l) => `  ${l}`));
  if (res.hidden > 0) lines.push(`  … ${res.hidden} more rows (see --tree)`);
  const self = s.topSelf.slice(0, 6);
  lines.push('top self time:');
  lines.push(
    ...renderRows(
      self.map((f): Layout => ({
        left: `${truncate(orAnon(f.name), NAME_WIDTH)}${f.pkg && f.origin !== 'user' ? ` (${f.pkg})` : ''}`,
        nums: `self ${timeCol(f.selfMs * 1000)} ${pctCol(f.share)}`,
        where: place(f.file, f.line),
      })),
      paint,
    ).map((l) => `  ${l}`),
  );
  const pk = s.packages.slice(0, 5);
  if (pk.length > 0) {
    lines.push(
      `packages (total time): ${pk.map((p) => `${p.name} ${fmtPct(p.share)}`).join(' · ')}`,
    );
  }
  const caveats = s.caveats.slice(0, 3).map((c) => c.summary);
  if (caveats.length > 0) lines.push(`caveats: ${caveats.join(' | ')}`);
  const next = nextForTree(ctx, res.rows, ti);
  // The most useful place to read source lines: the hottest function in the target's own code by
  // self time over the whole run (the rows shown above are only the top of the tree).
  const hottest =
    s.topSelf.find((f) => f.origin === 'user' && f.file !== '') ??
    s.topSelf.find((f) => f.file !== '' && !f.file.startsWith('node:') && f.origin !== 'native');
  const depPkg = pk.find((p) => !p.isTarget);
  if (depPkg && !next.some((n) => n.includes('--pkg'))) {
    next[next.length >= 3 ? 2 : next.length] = nextCmd(ctx, `--pkg ${shellArg(depPkg.name)}`);
  }
  if (hottest) {
    const hotId = resolveSelector(model, ti, hottest.name).matches.find((m) => {
      const l = locate(model, m.fn);
      return l.file === hottest.file && l.line === hottest.line;
    })?.fn;
    if (hotId !== undefined) {
      const at = next.findIndex((n) => n.includes('--lines'));
      next[at >= 0 ? at : Math.min(1, next.length)] = nextCmd(ctx, `--lines f${hotId}`);
    }
  }
  return finishView('summary', head, lines, next.slice(0, 3), {
    summary: s,
    tree: res.rows.map(jsonRow),
  });
}

/** Renders one view of a model, as text for people and agents and as JSON for programs. */
export function renderReport(ctx: ReportContext, flags: Flags): ReportOutput {
  const r = flags.report;
  const ti = trackIndexOf(ctx.model, r.track);
  if (r.callers !== undefined) return callersView(ctx, flags, ti);
  if (r.lines !== undefined) return linesView(ctx, flags, ti);
  if (r.tasks) return tasksView(ctx, flags, ti);
  if (r.phases) return phasesView(ctx, flags, ti);
  if (r.top !== undefined) return topView(ctx, flags, ti);
  if (r.pkg !== undefined && !r.tree && r.callees === undefined)
    return topView(ctx, flags, ti, r.pkg);
  if (r.callees !== undefined) {
    const { selector, note } = pick(ctx, ti, r.callees);
    return treeView(
      ctx,
      { ...flags, report: { ...r, depth: r.depth ?? 3 } },
      ti,
      `callees of ${r.callees}`,
      selector,
      note,
    );
  }
  if (r.tree || r.from !== undefined) {
    const picked = r.from !== undefined ? pick(ctx, ti, r.from) : undefined;
    return treeView(
      ctx,
      flags,
      ti,
      `call tree${picked ? ` from ${r.from}` : ''}`,
      picked?.selector,
      picked?.note,
    );
  }
  return summaryView(ctx, flags, ti);
}
