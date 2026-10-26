import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ExecutionModel } from '@pacesjs/engine';
import { loadModel, readSession } from '@pacesjs/format';
import { defaultBrowserFlags, defaultReportFlags } from './args.js';
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
}

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
  open(file: string, focus?: string[]): string;
}

interface Loaded {
  file: string;
  model: ExecutionModel;
  summary: () => AgentSummary;
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

/**
 * One MCP server for any number of investigations: `profile` runs a command and loads its session,
 * `open_session` loads a saved one, and the analysis tools answer about whichever is loaded.
 */
export function createPacesServer(options: PacesServerOptions): PacesServer {
  const { engine, cwd: serverCwd, preload } = options;
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

  return { tools, resources, instructions: MCP_INSTRUCTIONS, profile, open };
}
