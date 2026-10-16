export interface Flags {
  interval?: number;
  async: boolean;
  duration?: number;
  startOn?: string;
  out?: string;
  embedSources: boolean;
  noOpen: boolean;
  include: string[];
  exclude: string[];
  json: boolean;
  focus: string[];
}

export type Parsed =
  | { kind: 'profile'; flags: Flags; command: string[] }
  | { kind: 'open' | 'summary' | 'mcp' | 'import'; flags: Flags; files: [string] }
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
  paces open <file.paces>           reopen a saved session
  paces diff <a.paces> <b.paces>    compare two sessions (a is the baseline)
  paces import <file>               open a .cpuprofile or DevTools trace JSON
  paces summary <file.paces> [--json]   print findings, no UI
  paces mcp <file.paces>            serve findings to an AI agent over MCP (stdio)

Flags (before --)
  --interval <us>        sampling interval in microseconds (default 1000)
  --async                record async causality
  --duration <s>         stop profiling after N seconds, keep the app running
  --start-on <SIGNAL>    start profiling when paces receives the signal (not on Windows)
  --out <file>           session path (default ./.paces/<time>.paces)
  --embed-sources        copy source files and maps into the session
  --no-open              print the URL instead of opening a window
  --include <glob>       only profile matching processes (repeatable)
  --exclude <glob>       skip matching processes (repeatable)
  --focus <pkg|glob>     rank this package or path first in findings and summaries (repeatable)
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
const BOOL_FLAGS = new Set(['--async', '--embed-sources', '--no-open', '--json']);
const COMMANDS = new Set(['open', 'diff', 'import', 'summary', 'mcp']);

function positiveNumber(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new UsageError(`${flag} needs a positive number, got "${raw}".`);
  }
  return n;
}

/** Flags come before `--`; everything after it is the target command, untouched. */
export function parseArgs(argv: string[]): Parsed {
  const sep = argv.indexOf('--');
  const own = sep >= 0 ? argv.slice(0, sep) : argv;
  const command = sep >= 0 ? argv.slice(sep + 1) : [];
  const flags: Flags = {
    async: false,
    embedSources: false,
    noOpen: false,
    include: [],
    exclude: [],
    json: false,
    focus: [],
  };
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
      else if (name === '--embed-sources') flags.embedSources = true;
      else if (name === '--no-open') flags.noOpen = true;
      else flags.json = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
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
    else flags.exclude.push(value);
  }

  if (help) return { kind: 'help' };
  if (version) return { kind: 'version' };

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
  if (!COMMANDS.has(first)) {
    throw new UsageError(
      `Unknown command "${first}". To profile a command, put it after "--": paces -- ${positional.join(' ')}`,
    );
  }
  const files = positional.slice(1);
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
    kind: first as 'open' | 'summary' | 'mcp' | 'import',
    flags,
    files: [files[0] as string],
  };
}
