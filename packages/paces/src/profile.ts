import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { constants, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCaptureDir, socketPath } from '@pacesjs/collector-node';
import type { CaptureMeta, RawCapture } from '@pacesjs/engine';
import type { Flags } from './args.js';
import { UsageError } from './args.js';
import { shouldProfile } from './glob.js';
import { createInterruptHandler } from './interrupt.js';
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

/** Tracks that wrote anything: a profile, or at least the info file written next to it. */
function deliveredTracks(dir: string): Set<string> {
  const raw = join(dir, 'raw');
  const out = new Set<string>();
  if (!existsSync(raw)) return out;
  for (const name of readdirSync(raw)) out.add(name.slice(0, name.lastIndexOf('.')));
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
      argvByTrack.set(name.slice(0, -5), info.argv ?? []);
    } catch {
      // An unreadable info file leaves the track in; filtering is best effort.
    }
  }
  const processOf = (track: string): string => track.replace(/-w\d+$/, '');
  for (const name of readdirSync(raw)) {
    const track = name.slice(0, name.lastIndexOf('.'));
    const argv = argvByTrack.get(processOf(track));
    if (argv && !shouldProfile(argv, include, exclude)) rmSync(join(raw, name), { force: true });
  }
}

export async function runProfile(options: ProfileOptions): Promise<ProfileResult> {
  const { command, flags, cwd } = options;
  const log = options.log ?? (() => {});
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };

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

  let started = !flags.startOn;
  const conns = new Map<string, TrackConn>();
  const registrations = new Map<string, RegisteredTrack>();
  let allFlushedResolve: () => void = () => {};
  const allFlushed = new Promise<void>((r) => (allFlushedResolve = r));
  const checkFlushed = (): void => {
    if (conns.size === 0) return;
    for (const c of conns.values()) if (!c.flushed && !c.socket.destroyed) return;
    allFlushedResolve();
  };

  const server = createServer((socket) => {
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
          const msg = JSON.parse(line) as {
            type?: string;
            track?: string;
            pid?: number;
            threadId?: number;
            argv?: string[];
          };
          if (msg.type === 'register' && msg.track) {
            track = msg.track;
            registrations.set(track, {
              id: track,
              pid: msg.pid ?? 0,
              threadId: msg.threadId ?? 0,
              argv: msg.argv ?? [],
            });
            conns.set(track, { socket, flushed: false });
            if (started) socket.write(`${JSON.stringify({ type: 'start' })}\n`);
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
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(sock, ok);
  });

  const broadcast = (type: 'start' | 'stop' | 'sigint'): void => {
    for (const c of conns.values()) {
      if (!c.socket.destroyed) c.socket.write(`${JSON.stringify({ type })}\n`);
    }
  };

  const startedAt = Date.now();
  env.PACES_DIR = dir;
  env.PACES_SESSION = id;
  env.PACES_SOCKET = sock;
  env.PACES_INTERVAL = String(intervalUs);
  delete env.PACES_PARENT;
  if (flags.startOn) env.PACES_DEFER = '1';
  else delete env.PACES_DEFER;
  if (flags.async) env.PACES_ASYNC = '1';
  else delete env.PACES_ASYNC;
  env.NODE_OPTIONS = nodeOptionsWith(env.NODE_OPTIONS, options.preload);

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
        started = true;
        broadcast('start');
        log(`paces: profiling started on ${flags.startOn}`);
      }),
    );
  }

  let windowEnd: Promise<'duration'> | undefined;
  if (flags.duration) {
    windowEnd = new Promise<'duration'>((resolve) => {
      const t = setTimeout(() => {
        broadcast('stop');
        Promise.race([allFlushed, new Promise((r) => setTimeout(r, 5000).unref())]).then(() =>
          resolve('duration'),
        );
      }, flags.duration! * 1000);
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
    server.close();
    for (const c of conns.values()) c.socket.destroy();
    const delivered = deliveredTracks(dir);
    applyProcessFilters(dir, flags.include, flags.exclude);
    const lost = detectLostTracks({
      registered: [...registrations.values()],
      delivered,
      include: flags.include,
      exclude: flags.exclude,
      started,
    });
    const meta: CaptureMeta = {
      command,
      cwd,
      nodeVersion: process.version,
      platform: process.platform,
      mode: flags.async ? 'async' : intervalUs < 1000 ? 'fine' : 'default',
      intervalUs,
      startedAt,
      endedAt: Date.now(),
      endedBy,
      projectRoot: options.projectRoot ?? cwd,
      ...(lost.length > 0 ? { lostTracks: lost } : {}),
    };
    const capture = readCaptureDir(dir, meta);
    rmSync(dir, { recursive: true, force: true });
    // A parent that never flushed or was filtered out would leave a dangling link: promote to root.
    const ids = new Set(capture.tracks.map((t) => t.info.id));
    for (const t of capture.tracks) {
      if (t.info.parent !== undefined && !ids.has(t.info.parent)) delete t.info.parent;
    }
    return capture;
  };

  // The root exiting does not mean every flush landed: give straggler acks a moment.
  if (!stoppedEarly)
    await Promise.race([allFlushed, new Promise((r) => setTimeout(r, 200).unref())]);

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
