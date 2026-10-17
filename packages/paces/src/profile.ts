import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { constants, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCaptureDir, socketPath } from '@pacesjs/collector-node';
import type { ToCli, ToTarget } from '@pacesjs/collector-node';
import type { CaptureMeta, RawCapture } from '@pacesjs/engine';
import type { Flags } from './args.js';
import { UsageError } from './args.js';
import { shouldProfile } from './glob.js';
import { after, createInterruptHandler } from './interrupt.js';
import { killTree } from './launch.js';
import { detectLostTracks } from './lost-tracks.js';
import type { RegisteredTrack } from './lost-tracks.js';
import { planSpawn } from './spawn-plan.js';

export class NoProcessesError extends Error {
  constructor(
    command: string[],
    readonly exitCode = 1,
  ) {
    super(
      `No Node process loaded the profiler, so there is nothing to show. ` +
        `\`${command.join(' ')}\` may not be a Node program, or a wrapper removed NODE_OPTIONS. ` +
        `For a non-Node launcher, start Node yourself with --require "<paces preload>" or run paces on the node command directly.`,
    );
    this.name = 'NoProcessesError';
  }
}

export interface ProfileOptions {
  command: string[];
  flags: Flags;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Absolute path of preload.cjs. */
  preload: string;
  /** Receives plain progress lines (stderr in the CLI). */
  log?: (line: string) => void;
  /** Where Ctrl+C comes from; injectable for tests. Defaults to `process.on('SIGINT')`. */
  onInterrupt?: (handler: () => void) => () => void;
  /** Where the start-on signal comes from. Defaults to `process.on(signal)`. */
  onSignal?: (signal: string, handler: () => void) => () => void;
  /** Project root recorded in the session; defaults to `cwd`. */
  projectRoot?: string;
}

export interface ProfileResult {
  capture: RawCapture;
  exitCode: number;
  /** Set when profiling ended by `--duration` while the app is still running. */
  child?: { stop(): Promise<void> };
}

interface TrackConn {
  socket: Socket;
  flushed: boolean;
}

/** Forward slashes keep `NODE_OPTIONS` parseable on Windows; the quotes protect spaces. */
export function nodeOptionsWith(existing: string | undefined, preload: string): string {
  const entry = `--require "${preload.replaceAll('\\', '/')}"`;
  return existing && existing.trim() ? `${existing} ${entry}` : entry;
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const n = signal ? (constants.signals[signal] ?? 0) : 0;
  return n ? 128 + n : 1;
}

/** `p123-w1.cpuprofile` and `p123-w1.info` both belong to track `p123-w1`. */
const trackOfFile = (name: string): string => name.slice(0, name.lastIndexOf('.'));

/** Tracks that wrote anything: a profile, or at least the info file written next to it. */
function deliveredTracks(dir: string): Set<string> {
  const raw = join(dir, 'raw');
  const out = new Set<string>();
  if (!existsSync(raw)) return out;
  for (const name of readdirSync(raw)) out.add(trackOfFile(name));
  return out;
}

/** Removes raw files of processes that `--include/--exclude` filtered out. */
function applyProcessFilters(dir: string, include: string[], exclude: string[]): void {
  if (include.length === 0 && exclude.length === 0) return;
  const raw = join(dir, 'raw');
  if (!existsSync(raw)) return;
  const argvByTrack = new Map<string, string[]>();
  for (const name of readdirSync(raw)) {
    if (!name.endsWith('.info')) continue;
    try {
      const info = JSON.parse(readFileSync(join(raw, name), 'utf8')) as { argv?: string[] };
      argvByTrack.set(trackOfFile(name), info.argv ?? []);
    } catch {
      // An unreadable info file leaves the track in; filtering is best effort.
    }
  }
  const processOf = (track: string): string => track.replace(/-w\d+$/, '');
  for (const name of readdirSync(raw)) {
    const track = trackOfFile(name);
    const argv = argvByTrack.get(processOf(track));
    if (argv && !shouldProfile(argv, include, exclude)) rmSync(join(raw, name), { force: true });
  }
}

/** The control socket of one session: tracks register and report flushes, the CLI releases and stops them. */
interface ControlServer {
  server: Server;
  /** Tracks registering from now on are told to start at once; `--start-on` flips it when the signal comes. */
  started: boolean;
  conns: Map<string, TrackConn>;
  registrations: Map<string, RegisteredTrack>;
  /** Resolves once every connected track has acknowledged its flush (or hung up). */
  allFlushed: Promise<void>;
  broadcast(type: ToTarget['type']): void;
}

async function startControlServer(sock: string, started: boolean): Promise<ControlServer> {
  const conns = new Map<string, TrackConn>();
  const registrations = new Map<string, RegisteredTrack>();
  let allFlushedResolve: () => void = () => {};
  const allFlushed = new Promise<void>((r) => (allFlushedResolve = r));
  const checkFlushed = (): void => {
    if (conns.size === 0) return;
    for (const c of conns.values()) if (!c.flushed && !c.socket.destroyed) return;
    allFlushedResolve();
  };

  const control: ControlServer = {
    server: createServer((socket) => {
      let buf = '';
      let track: string | undefined;
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      socket.on('data', (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try {
            const msg = JSON.parse(line) as Partial<
              Omit<Extract<ToCli, { type: 'register' }>, 'type'>
            > & { type?: ToCli['type'] };
            if (msg.type === 'register' && msg.track) {
              track = msg.track;
              registrations.set(track, {
                id: track,
                pid: msg.pid ?? 0,
                threadId: msg.threadId ?? 0,
                argv: msg.argv ?? [],
              });
              conns.set(track, { socket, flushed: false });
              if (control.started) socket.write(`${JSON.stringify({ type: 'start' })}\n`);
            } else if (msg.type === 'flushed' && msg.track) {
              const c = conns.get(msg.track);
              if (c) c.flushed = true;
              checkFlushed();
            }
          } catch {
            // Ignore malformed control lines.
          }
        }
      });
      socket.on('close', checkFlushed);
    }),
    started,
    conns,
    registrations,
    allFlushed,
    broadcast: (type) => {
      for (const c of conns.values()) {
        if (!c.socket.destroyed) c.socket.write(`${JSON.stringify({ type })}\n`);
      }
    },
  };
  await new Promise<void>((ok, fail) => {
    control.server.once('error', fail);
    control.server.listen(sock, ok);
  });
  return control;
}

interface SessionEnv {
  dir: string;
  id: string;
  sock: string;
  intervalUs: number;
  flags: Flags;
  preload: string;
}

/** The environment of the profiled command: this session's PACES_* variables and the preload on NODE_OPTIONS. */
function pacesEnv(base: NodeJS.ProcessEnv, session: SessionEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  env.PACES_DIR = session.dir;
  env.PACES_SESSION = session.id;
  env.PACES_SOCKET = session.sock;
  env.PACES_INTERVAL = String(session.intervalUs);
  delete env.PACES_PARENT;
  if (session.flags.startOn) env.PACES_DEFER = '1';
  else delete env.PACES_DEFER;
  if (session.flags.async) env.PACES_ASYNC = '1';
  else delete env.PACES_ASYNC;
  env.NODE_OPTIONS = nodeOptionsWith(env.NODE_OPTIONS, session.preload);
  return env;
}

interface MetaInput {
  command: string[];
  cwd: string;
  flags: Flags;
  intervalUs: number;
  startedAt: number;
  endedBy: CaptureMeta['endedBy'];
  projectRoot: string;
  lost: ReturnType<typeof detectLostTracks>;
}

function captureMeta(m: MetaInput): CaptureMeta {
  return {
    command: m.command,
    cwd: m.cwd,
    nodeVersion: process.version,
    platform: process.platform,
    mode: m.flags.async ? 'async' : m.intervalUs < 1000 ? 'fine' : 'default',
    intervalUs: m.intervalUs,
    startedAt: m.startedAt,
    endedAt: Date.now(),
    endedBy: m.endedBy,
    projectRoot: m.projectRoot,
    ...(m.lost.length > 0 ? { lostTracks: m.lost } : {}),
  };
}

/** A parent that never flushed or was filtered out would leave a dangling link: promote to root. */
function promoteOrphanTracks(capture: RawCapture): void {
  const ids = new Set(capture.tracks.map((t) => t.info.id));
  for (const t of capture.tracks) {
    if (t.info.parent !== undefined && !ids.has(t.info.parent)) delete t.info.parent;
  }
}

export async function runProfile(options: ProfileOptions): Promise<ProfileResult> {
  const { command, flags, cwd } = options;
  const log = options.log ?? (() => {});
  const baseEnv: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };

  if (flags.startOn && process.platform === 'win32' && !options.onSignal) {
    throw new UsageError(
      '--start-on needs a POSIX signal and Windows has none. Use --duration <s> to profile a window instead.',
    );
  }
  if (command.some((a) => a.startsWith('--inspect'))) {
    log('paces: a debugger is attached via --inspect; the profile may be incomplete.');
  }

  const id = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const dir = mkdtempSync(join(tmpdir(), 'paces-run-'));
  mkdirSync(join(dir, 'raw'), { recursive: true });
  const sock = socketPath(id);
  const intervalUs = flags.interval ?? 1000;

  const control = await startControlServer(sock, !flags.startOn);
  const { conns, registrations, allFlushed, broadcast } = control;

  const startedAt = Date.now();
  const env = pacesEnv(baseEnv, { dir, id, sock, intervalUs, flags, preload: options.preload });

  const plan = planSpawn(command, env);
  const child = spawn(plan.file, plan.args, {
    cwd,
    env,
    stdio: 'inherit',
    windowsVerbatimArguments: plan.verbatim,
    windowsHide: false,
  });
  const spawnFailed = new Promise<never>((_, reject) =>
    child.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        new Error(
          err.code === 'ENOENT'
            ? `Could not start \`${command[0]}\`: not found. Check the command name and your PATH.`
            : `Could not start \`${command[0]}\`: ${err.message}`,
        ),
      );
    }),
  );
  spawnFailed.catch(() => {});

  const exited = new Promise<number>((resolve) =>
    child.once('exit', (code, signal) => resolve(exitCodeOf(code, signal))),
  );

  let childDone = false;
  void exited.then(() => {
    childDone = true;
  });
  let endedBy: CaptureMeta['endedBy'] = 'exit';
  const cleanups: Array<() => void> = [];

  const interrupt = createInterruptHandler({
    sendStop: () => broadcast('stop'),
    sendSigint: () => broadcast('sigint'),
    kill: () => killTree(child),
    allFlushed,
    childExited: exited,
  });
  const onInterrupt =
    options.onInterrupt ??
    ((h: () => void) => {
      process.on('SIGINT', h);
      return () => process.off('SIGINT', h);
    });
  cleanups.push(
    onInterrupt(() => {
      endedBy = 'sigint';
      void interrupt();
    }),
  );

  if (flags.startOn) {
    const onSignal =
      options.onSignal ??
      ((sig: string, h: () => void) => {
        process.on(sig as NodeJS.Signals, h);
        return () => process.off(sig as NodeJS.Signals, h);
      });
    cleanups.push(
      onSignal(flags.startOn, () => {
        control.started = true;
        broadcast('start');
        log(`paces: profiling started on ${flags.startOn}`);
      }),
    );
  }

  let windowEnd: Promise<'duration'> | undefined;
  const { duration } = flags;
  if (duration) {
    windowEnd = new Promise<'duration'>((resolve) => {
      const t = setTimeout(() => {
        broadcast('stop');
        Promise.race([allFlushed, after(5000)]).then(() => resolve('duration'));
      }, duration * 1000);
      t.unref();
      void exited.then(() => clearTimeout(t));
    });
  }

  let exitCode: number;
  let stoppedEarly = false;
  try {
    const first = await Promise.race([
      spawnFailed,
      exited.then((c) => ({ exit: c })),
      ...(windowEnd ? [windowEnd] : []),
    ]);
    if (first === 'duration') {
      endedBy = 'duration';
      stoppedEarly = true;
      exitCode = 0;
    } else exitCode = (first as { exit: number }).exit;
  } finally {
    for (const c of cleanups) c();
  }

  const finish = (): RawCapture => {
    control.server.close();
    for (const c of conns.values()) c.socket.destroy();
    const delivered = deliveredTracks(dir);
    applyProcessFilters(dir, flags.include, flags.exclude);
    const lost = detectLostTracks({
      registered: [...registrations.values()],
      delivered,
      include: flags.include,
      exclude: flags.exclude,
      started: control.started,
    });
    const meta = captureMeta({
      command,
      cwd,
      flags,
      intervalUs,
      startedAt,
      endedBy,
      projectRoot: options.projectRoot ?? cwd,
      lost,
    });
    const capture = readCaptureDir(dir, meta);
    rmSync(dir, { recursive: true, force: true });
    promoteOrphanTracks(capture);
    return capture;
  };

  // The root exiting does not mean every flush landed: give straggler acks a moment.
  if (!stoppedEarly) await Promise.race([allFlushed, after(200)]);

  const capture = finish();
  if (capture.tracks.length === 0) throw new NoProcessesError(command, exitCode);
  if (!stoppedEarly) return { capture, exitCode };
  return {
    capture,
    exitCode,
    child: {
      stop: async () => {
        if (childDone) return;
        killTree(child);
        await exited;
      },
    },
  };
}

export function preloadPath(importMetaUrl: string, resolveFallback: () => string): string {
  const here = dirname(fileURLToPath(importMetaUrl));
  const bundled = join(here, 'preload.cjs');
  return existsSync(bundled) ? bundled : resolveFallback();
}
