import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startRecording } from '@pacesjs/collector-browser';
import type { BrowserRun, RecordOptions } from '@pacesjs/collector-browser';
import type { ExecutionModel } from '@pacesjs/engine';
import { loadModel, readSession } from '@pacesjs/format';
import { defaultBrowserFlags, defaultReportFlags } from './args.js';
import {
  chooseBrowser,
  realBrowserDeps,
  recordOptionsFor,
  recordingToRawCapture,
  sessionExtras,
} from './browser-command.js';
import type { ChosenBrowser } from './browser-command.js';
import type { Flags } from './args.js';
import type { AgentSummary, Engine } from './engine.js';
import type { McpResource, McpTool, McpToolContext } from './mcp.js';
import { GUIDE_URI, MCP_GUIDE, MCP_INSTRUCTIONS } from './mcp-guide.js';
import { toolsOver } from './mcp-tools.js';
import { runProfile } from './profile.js';
import { saveSession } from './save-session.js';
import { defaultSessionPath, findProjectRoot } from './session-files.js';

const NO_SESSION = 'No session yet: call profile or open_session first.';
/** A program that never exits would hold the tool call open; stop profiling after this long. */
export const DEFAULT_DURATION_S = 120;
const MAX_DURATION_S = 900;
const LISTED_SESSIONS = 20;

export interface PacesServerOptions {
  engine: Engine;
  /** Where relative paths and the `.paces` folder are resolved from. */
  cwd: string;
  /** Absolute path of preload.cjs. */
  preload: string;
  /** Receives plain progress lines (stderr in the CLI). */
  log?: (line: string) => void;
  /** How a page is recorded; the real browser unless a test stands in. */
  browser?: BrowserHooks;
}

export interface BrowserHooks {
  choose(): Promise<ChosenBrowser>;
  record(options: RecordOptions): Promise<BrowserRun>;
}

export interface BrowserProfileRequest {
  url: string;
  /** `load`, `idle`, or seconds. Default `load`. */
  until?: 'load' | 'idle' | number;
  throttle?: number;
  firstParty?: string[];
  cwd?: string;
}

const MAX_UNTIL_S = 300;

export interface ProfileRequest {
  command: string[];
  cwd?: string;
  /** Seconds before profiling stops and the program is ended. */
  duration?: number;
  interval?: number;
  v8?: boolean;
  async?: boolean;
  focus?: string[];
  /** Session file; defaults to `<cwd>/.paces/<time>.paces`. */
  out?: string;
}

export interface ProfileOutcome {
  session: string;
  exitCode: number;
  endedBy: string;
  tracks: number;
  lostTracks?: number;
  summary: AgentSummary;
}

export interface PacesServer {
  tools: McpTool[];
  resources: McpResource[];
  instructions: string;
  profile(request: ProfileRequest, ctx: McpToolContext): Promise<ProfileOutcome>;
  profileBrowser(request: BrowserProfileRequest, ctx: McpToolContext): Promise<ProfileOutcome>;
  open(file: string, focus?: string[]): string;
}

interface Loaded {
  file: string;
  model: ExecutionModel;
  summary: () => AgentSummary;
}

/** The flags a page recording takes from an MCP request: a visible window, no terminal. */
function mcpFlags(browser: Partial<Flags['browser']>): Flags {
  return {
    async: false,
    v8: false,
    embedSources: false,
    noOpen: true,
    browser: { ...defaultBrowserFlags(), ...browser },
    include: [],
    exclude: [],
    json: false,
    focus: [],
    report: defaultReportFlags(),
  };
}

function field<T>(
  args: Record<string, unknown>,
  key: string,
  check: (v: unknown) => v is T,
  what: string,
): T | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (!check(v)) throw new Error(`${key} must be ${what}.`);
  return v;
}

const isString = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

function positive(max: number) {
  return (v: unknown): v is number => typeof v === 'number' && v > 0 && v <= max;
}

function parseProfileArgs(args: Record<string, unknown>): ProfileRequest {
  const command = args.command;
  if (command === undefined || (Array.isArray(command) && command.length === 0)) {
    throw new Error('command is required: an array like ["node", "app.js"] or ["npm", "test"].');
  }
  if (!isStrings(command)) {
    throw new Error(
      'command must be an array of strings, one per argument, not a shell string. Example: ["node", "app.js"].',
    );
  }
  return {
    command,
    cwd: field(args, 'cwd', isString, 'a directory path'),
    duration: field(
      args,
      'duration',
      positive(MAX_DURATION_S),
      `seconds, above 0 and up to ${MAX_DURATION_S}`,
    ),
    interval: field(args, 'interval', positive(1_000_000), 'a sampling interval in microseconds'),
    v8: field(args, 'v8', isBoolean, 'true or false'),
    async: field(args, 'async', isBoolean, 'true or false'),
    focus: field(args, 'focus', isStrings, 'an array of package names or globs'),
  };
}

function parseBrowserArgs(args: Record<string, unknown>): BrowserProfileRequest {
  const url = args.url;
  if (url === undefined) {
    throw new Error('url is required: the page to open, like http://localhost:3000.');
  }
  if (!isString(url)) throw new Error('url must be a non-empty string.');
  const until = args.until;
  if (
    until !== undefined &&
    until !== 'load' &&
    until !== 'idle' &&
    !(typeof until === 'number' && until > 0 && until <= MAX_UNTIL_S)
  ) {
    throw new Error(
      `until must be "load", "idle" or a number of seconds above 0 and up to ${MAX_UNTIL_S}.`,
    );
  }
  return {
    url,
    ...(until === undefined ? {} : { until }),
    throttle: field(args, 'throttle', positive(20), 'a CPU slowdown like 4, up to 20'),
    firstParty: field(args, 'firstParty', isStrings, 'an array of URL globs'),
    cwd: field(args, 'cwd', isString, 'a directory path'),
  };
}

/**
 * One MCP server for any number of investigations: `profile` runs a command and loads its session,
 * `open_session` loads a saved one, and the analysis tools answer about whichever is loaded.
 */
export function createPacesServer(options: PacesServerOptions): PacesServer {
  const { engine, cwd: serverCwd, preload } = options;
  const browserHooks: BrowserHooks = options.browser ?? {
    choose: () => chooseBrowser(mcpFlags({}), realBrowserDeps),
    record: (o) => startRecording(o),
  };
  const log = options.log ?? (() => undefined);
  let current: Loaded | undefined;
  let running = false;

  const load = (file: string, model: ExecutionModel): Loaded => {
    let digest: AgentSummary | undefined;
    return { file, model, summary: () => (digest ??= engine.buildAgentSummary(model)) };
  };

  const dirOf = (cwd: string | undefined): string => {
    const dir = resolve(serverCwd, cwd ?? '.');
    if (!existsSync(dir) || !statSync(dir).isDirectory())
      throw new Error(`No such directory: ${dir}`);
    return dir;
  };

  async function profile(request: ProfileRequest, ctx: McpToolContext): Promise<ProfileOutcome> {
    if (running) {
      throw new Error(
        'paces is already profiling a command. Wait for it to finish, then call profile again.',
      );
    }
    running = true;
    try {
      const cwd = dirOf(request.cwd);
      const flags: Flags = {
        async: request.async ?? false,
        v8: request.v8 ?? false,
        duration: request.duration ?? DEFAULT_DURATION_S,
        ...(request.interval === undefined ? {} : { interval: request.interval }),
        embedSources: false,
        noOpen: true,
        browser: defaultBrowserFlags(),
        include: [],
        exclude: [],
        json: false,
        focus: request.focus ?? [],
        report: defaultReportFlags(),
      };
      const line = (l: string): void => {
        log(l);
        ctx.progress?.(l);
      };
      line(`paces: profiling \`${request.command.join(' ')}\` in ${cwd}`);
      const result = await runProfile({
        command: request.command,
        flags,
        cwd,
        preload,
        projectRoot: findProjectRoot(cwd),
        log: line,
        // Our stdout is the protocol and our stdin is the client's pipe: the program gets neither.
        holdStdin: true,
        stdoutFd: process.stderr.fd,
        onInterrupt: () => () => undefined,
        attach: (controls) => {
          const stop = (): void => controls.stop();
          if (ctx.signal.aborted) stop();
          else ctx.signal.addEventListener('abort', stop, { once: true });
          return () => ctx.signal.removeEventListener('abort', stop);
        },
      });
      try {
        const out = resolve(cwd, request.out ?? defaultSessionPath(cwd));
        const model = saveSession(result.capture, {
          out,
          engine,
          focus: flags.focus,
          embedSources: false,
          log: line,
        });
        if (!model) {
          throw new Error(
            `The session is saved to ${out} but could not be analyzed; update paces and call open_session on it.`,
          );
        }
        current = load(out, model);
        const lost = result.capture.meta.lostTracks?.length ?? 0;
        return {
          session: out,
          exitCode: result.exitCode,
          endedBy: result.capture.meta.endedBy,
          tracks: result.capture.tracks.length,
          ...(lost > 0 ? { lostTracks: lost } : {}),
          summary: current.summary(),
        };
      } finally {
        await result.child?.stop();
      }
    } finally {
      running = false;
    }
  }

  /** Opens a visible browser on a page, records it, and loads the session like `profile` does. */
  async function profileBrowser(
    request: BrowserProfileRequest,
    ctx: McpToolContext,
  ): Promise<ProfileOutcome> {
    if (running) {
      throw new Error(
        'paces is already profiling. Wait for it to finish, then call profile_browser again.',
      );
    }
    running = true;
    try {
      const cwd = dirOf(request.cwd);
      const chosen = await browserHooks.choose();
      if ('exitCode' in chosen) throw new Error(chosen.message);
      const flags = mcpFlags({
        firstParty: request.firstParty ?? [],
        ...(request.throttle ? { throttle: request.throttle } : {}),
      });
      const until = request.until ?? 'load';
      const base = recordOptionsFor(flags, request.url, chosen.exe);
      const record: RecordOptions =
        typeof until === 'number' ? { ...base, durationMs: until * 1000 } : { ...base, until };
      const line = (l: string): void => {
        log(l);
        ctx.progress?.(l);
      };
      line(`paces: recording ${request.url} in ${chosen.name}`);
      const run = await browserHooks.record(record);
      const stop = (): void => void run.stop('stop').catch(() => undefined);
      if (ctx.signal.aborted) stop();
      else ctx.signal.addEventListener('abort', stop, { once: true });
      try {
        const recording = await run.done;
        const capture = recordingToRawCapture(recording, flags, {
          cwd: findProjectRoot(cwd),
          platform: process.platform,
        });
        const out = resolve(cwd, defaultSessionPath(cwd));
        const model = saveSession(capture, {
          out,
          engine,
          focus: [],
          embedSources: false,
          log: line,
          browser: sessionExtras(recording),
        });
        if (!model) {
          throw new Error(
            `The session is saved to ${out} but could not be analyzed; update paces and call open_session on it.`,
          );
        }
        current = load(out, model);
        return {
          session: out,
          exitCode: 0,
          endedBy: capture.meta.endedBy,
          tracks: capture.tracks.length,
          summary: current.summary(),
        };
      } finally {
        ctx.signal.removeEventListener('abort', stop);
      }
    } finally {
      running = false;
    }
  }

  function open(file: string, focus: string[] = []): string {
    const path = resolve(serverCwd, file);
    if (!existsSync(path)) throw new Error(`No such file: ${path}`);
    const session = readSession(new Uint8Array(readFileSync(path)), {
      engineVersion: engine.engineVersion,
    });
    const model = loadModel(session, engine, focus.length > 0 ? { focus } : undefined).model;
    current = load(path, model);
    return path;
  }

  function sessionsIn(cwd: string | undefined): Array<Record<string, unknown>> {
    const dir = join(dirOf(cwd), '.paces');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => n.endsWith('.paces'))
      .map((n) => ({ path: join(dir, n), mtime: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? 1 : -1))
      .slice(0, LISTED_SESSIONS)
      .map(({ path }) => {
        try {
          const { manifest } = readSession(new Uint8Array(readFileSync(path)));
          return { path, command: manifest.command, startedAt: manifest.startedAt };
        } catch {
          return { path, unreadable: true };
        }
      });
  }

  const analysis = toolsOver(() => {
    if (!current) throw new Error(NO_SESSION);
    return current;
  });

  const tools: McpTool[] = [
    {
      name: 'profile',
      description:
        'Run a command under the Node CPU profiler and load the result for the other tools. command is an argument array like ["node","app.js"] or ["npm","test"]; child processes (npx, npm, workers) are profiled too. The command really runs, so this takes as long as it does: profiling stops after duration seconds (default ' +
        `${DEFAULT_DURATION_S}, so give a duration for a server) and the program is ended. cwd is where it runs and where the session is saved (.paces/). v8 also records V8 deoptimizations and may print trace lines to the program's output. Returns the session path, the program's exit code (non-zero is data, not an error) and the same digest as summary. One profile runs at a time.`,
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'array', items: { type: 'string' }, minItems: 1 },
          cwd: {
            type: 'string',
            description: 'Directory to run in. Default: the server directory.',
          },
          duration: {
            type: 'number',
            minimum: 1,
            maximum: MAX_DURATION_S,
            description: `Seconds before profiling stops. Default ${DEFAULT_DURATION_S}.`,
          },
          interval: {
            type: 'number',
            description: 'Sampling interval in microseconds. Default 1000.',
          },
          v8: { type: 'boolean', description: 'Record V8 deoptimizations. Default false.' },
          async: { type: 'boolean', description: 'Record async causality. Default false.' },
          focus: {
            type: 'array',
            items: { type: 'string' },
            description: 'Packages or globs to rank first.',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      run: (args, ctx) => profile(parseProfileArgs(args), ctx),
    },
    {
      name: 'profile_browser',
      description:
        'Open a visible browser window on the user\'s machine, load a web page and record what its JavaScript did, plus rendering, frames, input and loading milestones; the result is loaded for the other tools. WARNING: the page\'s own JavaScript runs on the user\'s machine, so only open pages the user asked for or the project\'s own dev server. Needs a desktop session and a Chromium browser (Chrome, Edge, Brave, Vivaldi, Opera, Chromium); refused without a display. until is "load" (default: stop shortly after the page loads), "idle" (stop when the network goes quiet) or seconds up to 300. A fresh temporary browser profile is used, so nothing is logged in. Returns the session path and the same digest as summary. One profile runs at a time, of either kind.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The page to open, like http://localhost:3000.' },
          until: {
            description: 'When to stop: "load", "idle", or a number of seconds (up to 300).',
            oneOf: [
              { type: 'string', enum: ['load', 'idle'] },
              { type: 'number', minimum: 1, maximum: MAX_UNTIL_S },
            ],
          },
          throttle: {
            type: 'number',
            minimum: 1,
            maximum: 20,
            description: 'Slow the CPU down this many times, like 4.',
          },
          firstParty: {
            type: 'array',
            items: { type: 'string' },
            description: "Extra URL globs to count as the project's own code.",
          },
          cwd: {
            type: 'string',
            description: 'Where the session is saved (.paces/). Default: the server directory.',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      run: async (args, ctx) => profileBrowser(parseBrowserArgs(args), ctx),
    },
    {
      name: 'open_session',
      description:
        'Load a saved .paces session so the analysis tools answer about it. Use list_sessions to find one.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      run: (args) => {
        const path = field(args, 'path', isString, 'a file path');
        if (path === undefined) throw new Error('path is required.');
        const file = open(path);
        return { session: file, summary: (current as Loaded).summary() };
      },
    },
    {
      name: 'list_sessions',
      description:
        "List saved sessions in a directory's .paces folder, newest first (up to 20), with the command that was profiled.",
      inputSchema: {
        type: 'object',
        properties: { cwd: { type: 'string', description: 'Default: the server directory.' } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      run: (args) => sessionsIn(field(args, 'cwd', isString, 'a directory path')),
    },
    ...analysis,
  ];

  const resources: McpResource[] = [
    {
      uri: GUIDE_URI,
      name: 'guide',
      title: 'How to use paces, and a warning about running code',
      description:
        'How the profile and analysis tools fit together, how to read the numbers, and what to be careful about: profile runs the command it is given.',
      mimeType: 'text/markdown',
      text: MCP_GUIDE,
    },
  ];

  return { tools, resources, instructions: MCP_INSTRUCTIONS, profile, profileBrowser, open };
}
