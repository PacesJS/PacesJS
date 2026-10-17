import { ORIGIN_NAMES, callersOf, hotPaths, packageBreakdown } from '@pacesjs/engine';
import type { CallerNode, ExecutionModel, FnId, Track } from '@pacesjs/engine';
import type { AgentSummary } from './engine.js';
import { fnFacts, originName } from './fn-facts.js';
import type { McpTool } from './mcp.js';
import { orAnon, round3 as share } from './report/format.js';

const ms = (us: number): number => Math.round(us / 100) / 10;

class ToolInputError extends Error {}

function int(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const v = args[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new ToolInputError(`${key} must be a positive integer.`);
  }
  return Math.min(v, max);
}

function str(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const v = args[key];
  if (v === undefined) {
    if (required) throw new ToolInputError(`${key} is required.`);
    return undefined;
  }
  if (typeof v !== 'string' || v === '')
    throw new ToolInputError(`${key} must be a non-empty string.`);
  return v;
}

function oneOf<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = str(args, key);
  if (v === undefined) return undefined;
  if (!allowed.includes(v as T))
    throw new ToolInputError(`${key} must be one of: ${allowed.join(', ')}.`);
  return v as T;
}

/** The tools an agent uses to find where time goes, over one loaded model. Times are sampled estimates. */
export function buildTools(model: ExecutionModel, summary: () => AgentSummary): McpTool[] {
  const primary = model.primaryTrack;
  const targetTracks = model.tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.role !== 'support');
  const primaryBusy = (model.tracks[primary] as Track).busyUs || 1;
  const indexOf = new Map<Track, Map<FnId, number>>();
  const slot = (t: Track, fn: FnId): number | undefined => {
    let m = indexOf.get(t);
    if (!m) {
      m = new Map();
      t.fnIds.forEach((id, i) => m?.set(id, i));
      indexOf.set(t, m);
    }
    return m.get(fn);
  };
  const str_ = (id: number): string => model.strings[id] ?? '';

  const fnIdentity = (fn: FnId) => {
    const f = fnFacts(model, fn, false);
    return {
      name: orAnon(f.name),
      package: f.pkg,
      file: f.file,
      line: f.line,
      origin: originName(f.origin),
    };
  };

  const ref = (fn: FnId) => {
    const t = model.tracks[primary] as Track;
    const i = slot(t, fn);
    const self = i === undefined ? 0 : (t.agg.fnSelf[i] ?? 0);
    const total = i === undefined ? 0 : (t.agg.fnTotal[i] ?? 0);
    return {
      ...fnIdentity(fn),
      selfMs: ms(self),
      totalMs: ms(total),
      share: share(total / primaryBusy),
    };
  };

  const callerJson = (c: CallerNode): unknown => ({
    ...ref(c.fn),
    viaCallerMs: ms(c.weightUs),
    estimatedCalls: c.calls,
    callers: c.callers.map(callerJson),
  });

  const find = (name: string, file: string | undefined): { fn: FnId; alternatives: unknown[] } => {
    const t = model.tracks[primary] as Track;
    const hits: Array<{ fn: FnId; total: number }> = [];
    t.fnIds.forEach((fn, i) => {
      if (str_(model.functions.name[fn] ?? 0) !== name) return;
      if (file && !str_(model.functions.file[fn] ?? 0).includes(file)) return;
      hits.push({ fn, total: t.agg.fnTotal[i] ?? 0 });
    });
    hits.sort((a, b) => b.total - a.total || a.fn - b.fn);
    const best = hits[0];
    if (!best) {
      throw new ToolInputError(
        `No function named "${name}" in the primary track. Use top_functions to list names.`,
      );
    }
    return { fn: best.fn, alternatives: hits.slice(1, 6).map((h) => ref(h.fn)) };
  };

  const origins = ORIGIN_NAMES as readonly string[];

  return [
    {
      name: 'summary',
      description:
        'Whole-profile digest: what ran (target, run kind, primary track), findings with source locations, top functions by self time, hot paths, packages, phases and caveats. Start here. Times are sampled estimates.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => summary(),
    },
    {
      name: 'findings',
      description: 'Only the findings, most important first. Optional severity filter.',
      inputSchema: {
        type: 'object',
        properties: { severity: { type: 'string', enum: ['high', 'medium', 'low'] } },
        additionalProperties: false,
      },
      run: (args) => {
        const severity = oneOf(args, 'severity', ['high', 'medium', 'low'] as const);
        const all = (summary().findings ?? []) as Array<{ severity?: string }>;
        return severity ? all.filter((f) => f.severity === severity) : all;
      },
    },
    {
      name: 'hot_paths',
      description:
        'Dominant call chains of the primary process, outermost frame first, ranked by total time. With origin, other origins are folded into their caller, e.g. origin "user" shows which of the target\'s own functions are on the path.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 8.' },
          origin: { type: 'string', enum: [...origins] },
        },
        additionalProperties: false,
      },
      run: (args) => {
        const limit = int(args, 'limit', 8, 20);
        const origin = oneOf(args, 'origin', ORIGIN_NAMES);
        const idx = origin === undefined ? undefined : origins.indexOf(origin);
        const paths = hotPaths(model, primary, {
          limit,
          ...(idx === undefined ? {} : { origin: idx as never }),
        });
        return paths.map((p) => ({
          share: share(p.share),
          selfMs: ms(p.selfUs),
          totalMs: ms(p.totalUs),
          path: p.fns.map((fn) => ref(fn)),
        }));
      },
    },
    {
      name: 'top_functions',
      description:
        'Functions ranked by self or total time across the target processes. Filter by origin (user, dependency, framework, node, native) or by package name. Share is of the primary process busy time.',
      inputSchema: {
        type: 'object',
        properties: {
          sort: { type: 'string', enum: ['self', 'total'], description: 'Default self.' },
          origin: { type: 'string', enum: [...origins] },
          package: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 15.' },
        },
        additionalProperties: false,
      },
      run: (args) => {
        const sort = oneOf(args, 'sort', ['self', 'total'] as const) ?? 'self';
        const origin = oneOf(args, 'origin', ORIGIN_NAMES);
        const pkg = str(args, 'package');
        const limit = int(args, 'limit', 15, 50);
        const self = new Map<FnId, number>();
        const total = new Map<FnId, number>();
        for (const { t } of targetTracks) {
          t.fnIds.forEach((fn, i) => {
            self.set(fn, (self.get(fn) ?? 0) + (t.agg.fnSelf[i] ?? 0));
            total.set(fn, (total.get(fn) ?? 0) + (t.agg.fnTotal[i] ?? 0));
          });
        }
        const rows = [...self.keys()]
          .filter((fn) => {
            const o = ORIGIN_NAMES[model.functions.origin[fn] ?? 0];
            const name = str_(model.functions.name[fn] ?? 0);
            if (o === 'idle' || o === 'gc' || name === '(root)') return false;
            if (origin && o !== origin) return false;
            return !pkg || str_(model.functions.pkg[fn] ?? 0) === pkg;
          })
          .map((fn) => ({ fn, self: self.get(fn) ?? 0, total: total.get(fn) ?? 0 }))
          .filter((r) => r.self > 0 || r.total > 0)
          .sort((a, b) => (sort === 'self' ? b.self - a.self : b.total - a.total) || a.fn - b.fn)
          .slice(0, limit);
        return rows.map((r) => ({
          ...fnIdentity(r.fn),
          selfMs: ms(r.self),
          totalMs: ms(r.total),
          share: share((sort === 'self' ? r.self : r.total) / primaryBusy),
        }));
      },
    },
    {
      name: 'package_breakdown',
      description:
        'Which functions of one package (a dependency, a plugin or the target package itself) are hot, by self time, in the primary process.',
      inputSchema: {
        type: 'object',
        properties: { package: { type: 'string' } },
        required: ['package'],
        additionalProperties: false,
      },
      run: (args) => {
        const pkg = str(args, 'package', true) as string;
        const rows = packageBreakdown(model, primary, pkg).slice(0, 30);
        return rows.map((r) => ({
          ...ref(r.fn),
          selfMs: ms(r.self),
          totalMs: ms(r.total),
          share: share(r.total / primaryBusy),
        }));
      },
    },
    {
      name: 'callers',
      description:
        'Who calls a function, heaviest caller first, up to depth levels (1 to 4). Identify the function by name; use file to disambiguate. If several share the name the busiest is used and the others are listed as alternatives.',
      inputSchema: {
        type: 'object',
        properties: {
          function: { type: 'string' },
          file: { type: 'string', description: 'Substring of the file path, to disambiguate.' },
          depth: { type: 'integer', minimum: 1, maximum: 4, description: 'Default 2.' },
        },
        required: ['function'],
        additionalProperties: false,
      },
      run: (args) => {
        const { fn, alternatives } = find(str(args, 'function', true) as string, str(args, 'file'));
        const depth = int(args, 'depth', 2, 4);
        return {
          function: ref(fn),
          callers: callersOf(model, primary, fn, depth).map(callerJson),
          alternatives,
        };
      },
    },
    {
      name: 'phases',
      description:
        'Time-ordered phases of the primary process (startup and module loading, config loading, main work, waiting) with the hottest functions of each.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => summary().phases ?? [],
    },
  ];
}
