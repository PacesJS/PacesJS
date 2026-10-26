import { ORIGIN_NAMES } from '@pacesjs/engine';

export interface Flags {
  interval?: number;
  async: boolean;
  v8: boolean;
  duration?: number;
  startOn?: string;
  out?: string;
  embedSources: boolean;
  noOpen: boolean;
  /** `--no-keys` turns the terminal hotkeys off and leaves stdin alone; they are on in a terminal otherwise. */
  keys?: boolean;
  /** `--no-panel` keeps the status panel at the bottom of the terminal off. */
  noPanel?: boolean;
  include: string[];
  exclude: string[];
  json: boolean;
  focus: string[];
  report: ReportFlags;
}

export type TopSort = 'self' | 'total';
export type TreeSortFlag = 'total' | 'self' | 'time';

/** Flags of `paces report` and `paces --report`: which view, and how to cut it down. */
export interface ReportFlags {
  /** `paces --report -- <cmd>`: print the report after profiling, open no window. */
  runMode: boolean;
  tree: boolean;
  phases: boolean;
  tasks: boolean;
  callers?: string;
  callees?: string;
  lines?: string;
  pkg?: string;
  top?: TopSort;
  from?: string;
  depth?: number;
  minMs?: number;
  /** Fraction of the root, 0..1. */
  minShare?: number;
  sort?: TreeSortFlag;
  limit?: number;
  origin?: string[];
  expand: string[];
  noCollapse: boolean;
  task?: string;
  track?: string;
  maxLines?: number;
  noColor: boolean;
}

export function defaultReportFlags(): ReportFlags {
  return {
    runMode: false,
    tree: false,
    phases: false,
    tasks: false,
    expand: [],
    noCollapse: false,
    noColor: false,
  };
}

export type Parsed =
  | { kind: 'profile'; flags: Flags; command: string[] }
  | { kind: 'open' | 'summary' | 'import' | 'report'; flags: Flags; files: [string] }
  | { kind: 'mcp'; flags: Flags; files: [] | [string] }
  | { kind: 'mcp-run'; flags: Flags; command: string[] }
  | { kind: 'guide' }
  | { kind: 'diff'; flags: Flags; files: [string, string] }
  | { kind: 'help' }
  | { kind: 'version' };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const USAGE = `paces: profile a Node command and read what the JavaScript did

Usage
  paces [flags] -- <command...>     profile a command, then open the UI
  paces --report [flags] -- <cmd>   profile, print a report with next: drill-down commands, exit
  paces report <file> [flags]       drill into a saved session (.paces or .cpuprofile)
  paces guide                       print a usage guide for coding agents
  paces open <file.paces>           reopen a saved session (a profile file is imported)
  paces diff <a.paces> <b.paces>    compare two sessions (a is the baseline)
  paces import <file>               open a .cpuprofile or DevTools trace JSON (.gz is fine)
  paces summary <file.paces> [--json]   print findings, no UI
  paces mcp                         serve paces over MCP (stdio); the client's profile tool runs commands
  paces mcp <file.paces>            the same, with a saved session already loaded
  paces mcp [flags] -- <cmd...>     the same, after profiling a command

Flags (before --)
  --interval <us>        sampling interval in microseconds (default 1000)
  --async                record async causality
  --v8                   record V8 deoptimizations to find easy optimizations. V8 prints some trace
                         lines to stdout, like ") (opt id 5) for deoptimization, reason: ...]", so
                         the program's stdout can gain a few lines in this mode
  --duration <s>         stop profiling after N seconds, keep the app running
  --start-on <SIGNAL>    start profiling when paces receives the signal (not on Windows)
  --out <file>           session path (default ./.paces/<time>.paces)
  --embed-sources        copy source files and maps into the session
  --no-open              print the URL instead of opening a window
  --no-keys              no terminal hotkeys (m adds a mark, s stops and shows results). The keys are
                         on by default in a terminal and take the keyboard: the program gets an empty
                         stdin. Use --no-keys for a program that reads stdin; paces then leaves stdin
                         alone and marks are off.
  --no-panel             no status panel at the bottom of the terminal; print a line now and then
  --include <glob>       only profile matching processes (repeatable)
  --exclude <glob>       skip matching processes (repeatable)
  --focus <pkg|glob>     rank this package or path first in findings and summaries (repeatable)

Report flags (paces report, paces --report)
  views: --tree  --callers <sel>  --callees <sel>  --top self|total  --pkg <name>  --lines <sel>
         --phases  --tasks            (default: summary)
  shape: --from <sel>  --depth N  --min-ms N  --min-share 1%  --sort total|self|time  --limit N
         --origin user,dependency,node,native,gc  --expand <pkg>  --no-collapse  --task <n|whole>
         --track <id|primary>  --max-lines N  --json  --no-color
  <sel>: a function name, a path a,b,c, file.js:123, or an id like f123 (see: paces guide)
`;

const VALUE_FLAGS = new Set([
  '--interval',
  '--duration',
  '--start-on',
  '--out',
  '--include',
  '--exclude',
  '--focus',
]);
const REPORT_VALUE_FLAGS = new Set([
  '--callers',
  '--callees',
  '--lines',
  '--pkg',
  '--top',
  '--from',
  '--depth',
  '--min-ms',
  '--min-share',
  '--sort',
  '--limit',
  '--origin',
  '--expand',
  '--task',
  '--track',
  '--max-lines',
]);
const BOOL_FLAGS = new Set([
  '--async',
  '--v8',
  '--embed-sources',
  '--no-open',
  '--keys',
  '--no-keys',
  '--no-panel',
  '--json',
  '--report',
  '--tree',
  '--phases',
  '--tasks',
  '--no-collapse',
  '--no-color',
]);
const COMMANDS = new Set(['open', 'diff', 'import', 'summary', 'mcp', 'report', 'guide']);

function positiveNumber(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new UsageError(`${flag} needs a positive number, got "${raw}".`);
  }
  return n;
}

function integer(flag: string, raw: string, min = 0): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min)
    throw new UsageError(`${flag} needs a whole number of at least ${min}, got "${raw}".`);
  return n;
}

/** `1%` and `1` mean 1 percent; `0.01` means the same. */
function share(flag: string, raw: string): number {
  const pct = raw.endsWith('%');
  const n = Number(pct ? raw.slice(0, -1) : raw);
  if (!Number.isFinite(n) || n < 0)
    throw new UsageError(`${flag} needs a share like 1% or 0.01, got "${raw}".`);
  return pct || n > 1 ? n / 100 : n;
}

function oneOf<T extends string>(flag: string, raw: string, allowed: readonly T[]): T {
  if (!allowed.includes(raw as T))
    throw new UsageError(`${flag} must be one of: ${allowed.join(', ')}. Got "${raw}".`);
  return raw as T;
}

function applyReportFlag(r: ReportFlags, name: string, value: string): void {
  if (name === '--callers') r.callers = value;
  else if (name === '--callees') r.callees = value;
  else if (name === '--lines') r.lines = value;
  else if (name === '--pkg') r.pkg = value;
  else if (name === '--top') r.top = oneOf(name, value, ['self', 'total'] as const);
  else if (name === '--from') r.from = value;
  else if (name === '--depth') r.depth = integer(name, value, 1);
  else if (name === '--min-ms') r.minMs = positiveNumber(name, value);
  else if (name === '--min-share') r.minShare = share(name, value);
  else if (name === '--sort') r.sort = oneOf(name, value, ['total', 'self', 'time'] as const);
  else if (name === '--limit') r.limit = integer(name, value, 1);
  else if (name === '--origin') {
    r.origin = value.split(',').map((o) => oneOf(name, o.trim(), ORIGIN_NAMES));
  } else if (name === '--expand') r.expand.push(value);
  else if (name === '--task') {
    if (value !== 'whole') integer(name, value, 0);
    r.task = value;
  } else if (name === '--track') r.track = value;
  else if (name === '--max-lines') r.maxLines = integer(name, value, 8);
}

/** Flags come before `--`; everything after it is the target command, untouched. */
export function parseArgs(argv: string[]): Parsed {
  const sep = argv.indexOf('--');
  const own = sep >= 0 ? argv.slice(0, sep) : argv;
  const command = sep >= 0 ? argv.slice(sep + 1) : [];
  const flags: Flags = {
    async: false,
    v8: false,
    embedSources: false,
    noOpen: false,
    include: [],
    exclude: [],
    json: false,
    focus: [],
    report: defaultReportFlags(),
  };
  const r = flags.report;
  const positional: string[] = [];
  let help = false;
  let version = false;

  for (let i = 0; i < own.length; i++) {
    const arg = own[i] as string;
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      version = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    if (BOOL_FLAGS.has(name)) {
      if (eq >= 0) throw new UsageError(`${name} does not take a value.`);
      if (name === '--async') flags.async = true;
      else if (name === '--v8') flags.v8 = true;
      else if (name === '--embed-sources') flags.embedSources = true;
      else if (name === '--no-open') flags.noOpen = true;
      else if (name === '--keys') flags.keys = true;
      else if (name === '--no-keys') flags.keys = false;
      else if (name === '--no-panel') flags.noPanel = true;
      else if (name === '--json') flags.json = true;
      else if (name === '--report') r.runMode = true;
      else if (name === '--tree') r.tree = true;
      else if (name === '--phases') r.phases = true;
      else if (name === '--tasks') r.tasks = true;
      else if (name === '--no-collapse') r.noCollapse = true;
      else r.noColor = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name) && !REPORT_VALUE_FLAGS.has(name)) {
      throw new UsageError(
        `Unknown flag ${name}. Flags go before "--"; everything after it is passed to your command. See paces --help.`,
      );
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : own[++i];
    if (value === undefined || value === '') throw new UsageError(`${name} needs a value.`);
    if (name === '--interval') flags.interval = positiveNumber(name, value);
    else if (name === '--duration') flags.duration = positiveNumber(name, value);
    else if (name === '--start-on') flags.startOn = value;
    else if (name === '--out') flags.out = value;
    else if (name === '--include') flags.include.push(value);
    else if (name === '--focus') flags.focus.push(value);
    else if (name === '--exclude') flags.exclude.push(value);
    else applyReportFlag(r, name, value);
  }

  if (help) return { kind: 'help' };
  if (version) return { kind: 'version' };

  if (sep >= 0 && positional[0] === 'mcp') {
    if (command.length === 0)
      throw new UsageError('Nothing to run after "--". Example: paces mcp -- npm test');
    if (positional.length > 1) {
      throw new UsageError(
        'paces mcp takes either a file or a command after "--", not both. Example: paces mcp -- npm test',
      );
    }
    return { kind: 'mcp-run', flags, command };
  }

  if (sep >= 0) {
    if (command.length === 0)
      throw new UsageError('Nothing to run after "--". Example: paces -- node app.js');
    if (positional.length > 0) {
      throw new UsageError(
        `Unexpected "${positional[0]}" before "--". Flags go before "--", the command after.`,
      );
    }
    return { kind: 'profile', flags, command };
  }

  const first = positional[0];
  if (first === undefined) return { kind: 'help' };
  if (first === 'guide') return { kind: 'guide' };
  if (!COMMANDS.has(first)) {
    throw new UsageError(
      `Unknown command "${first}". To profile a command, put it after "--": paces -- ${positional.join(' ')}`,
    );
  }
  const files = positional.slice(1);
  if (first === 'mcp') {
    if (files.length > 1)
      throw new UsageError('paces mcp takes at most one file: paces mcp [file.paces]');
    return { kind: 'mcp', flags, files: files[0] === undefined ? [] : [files[0]] };
  }
  const need = first === 'diff' ? 2 : 1;
  if (files.length !== need) {
    throw new UsageError(
      need === 2
        ? 'paces diff needs two files: paces diff <baseline.paces> <head.paces>'
        : `paces ${first} needs one file: paces ${first} <file>`,
    );
  }
  if (first === 'diff')
    return { kind: 'diff', flags, files: [files[0] as string, files[1] as string] };
  return {
    kind: first as 'open' | 'summary' | 'import' | 'report',
    flags,
    files: [files[0] as string],
  };
}
