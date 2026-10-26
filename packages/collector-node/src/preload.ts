// Injected into every Node process of the target through NODE_OPTIONS (--require).
// Runs inside the user's process: keep it small, dependency-free and behavior-neutral.
import { createHook } from 'node:async_hooks';
import { Server } from 'node:http';
import { connect } from 'node:net';
import { Session } from 'node:inspector';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { isMainThread, threadId } from 'node:worker_threads';

interface ScriptRecord {
  scriptId: string;
  url: string;
  sourceMapURL: string;
  hash: string;
}

type RuntimeEvent =
  | { type: 'gc'; time: number; duration: number; kind: number }
  | { type: 'loop'; time: number; p50: number; p99: number; max: number }
  | {
      type: 'request';
      time: number;
      duration: number;
      method: string;
      url: string;
      status: number;
    }
  | {
      type: 'async';
      time: number;
      phase: 'init' | 'before' | 'after';
      asyncId: number;
      triggerAsyncId: number;
      asyncType: string;
    };

const FLAG = Symbol.for('paces.preload.active');

/**
 * Opt-in (--v8): V8 prints the tail of some trace messages straight to stdout, past the redirect, so
 * it changes the program's output. V8 refuses its logging flags in NODE_OPTIONS, but its trace flags
 * can still be set from the preload and are read when a deopt happens. The destination is
 * process-wide and opened on first write, so workers must not set it again: their deopts land in the
 * file of the process that owns them.
 */
function traceDeopts(raw: string, track: string): void {
  mkdirSync(raw, { recursive: true });
  for (const flag of [
    '--trace-deopt',
    '--trace-deopt-verbose',
    '--redirect-code-traces',
    `--redirect-code-traces-to=${join(raw, `${track}.deopt`)}`,
  ]) {
    setFlagsFromString(flag);
  }
}

function start(): void {
  const dir = process.env.PACES_DIR;
  const g = globalThis as Record<symbol, unknown>;
  if (!dir || g[FLAG]) return;
  g[FLAG] = true;

  // Children spawned by this process inherit the track id and link themselves to it.
  const parentTrack = process.env.PACES_PARENT;
  const interval = Number(process.env.PACES_INTERVAL) || 1000;
  const track = isMainThread ? `p${process.pid}` : `p${process.pid}-w${threadId}`;
  if (isMainThread) process.env.PACES_PARENT = track;
  if (isMainThread && process.env.PACES_V8_TRACE === '1') traceDeopts(join(dir, 'raw'), track);
  const session = new Session();
  session.connect();

  const scripts: ScriptRecord[] = [];
  session.on('Debugger.scriptParsed', ({ params }) => {
    scripts.push({
      scriptId: params.scriptId,
      url: params.url,
      sourceMapURL: params.sourceMapURL ?? '',
      hash: params.hash ?? '',
    });
  });

  const events: RuntimeEvent[] = [];
  const t0 = performance.timeOrigin;
  const gcObserver = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const detail = (e as unknown as { detail?: { kind?: number } }).detail;
      events.push({
        type: 'gc',
        time: t0 + e.startTime,
        duration: e.duration,
        kind: detail?.kind ?? 0,
      });
    }
  });
  gcObserver.observe({ entryTypes: ['gc'] });

  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const loopTimer = setInterval(() => {
    events.push({
      type: 'loop',
      time: Date.now(),
      p50: histogram.percentile(50) / 1e6,
      p99: histogram.percentile(99) / 1e6,
      max: histogram.max / 1e6,
    });
    histogram.reset();
  }, 100);
  loopTimer.unref();

  // Labels request tasks ("GET /orders"): a CPU profile alone cannot know the route.
  const emit = Server.prototype.emit;
  Server.prototype.emit = function (this: Server, event: string | symbol, ...args: unknown[]) {
    if (event === 'request') {
      const [req, res] = args as [
        { method?: string; url?: string },
        { statusCode: number; once(e: string, cb: () => void): void },
      ];
      const begin = performance.now();
      res.once('finish', () => {
        events.push({
          type: 'request',
          time: t0 + begin,
          duration: performance.now() - begin,
          method: req.method ?? 'GET',
          url: (req.url ?? '/').split('?')[0] ?? '/',
          status: res.statusCode,
        });
      });
    }
    return (emit as (...a: unknown[]) => boolean).call(this, event, ...args);
  } as typeof Server.prototype.emit;

  // Opt-in async causality (--async): fixed typed-array ring, no allocation per event. Only
  // (asyncId, triggerAsyncId, type, time) is stored; strings are interned once per async type.
  let drainAsync: () => void = () => {};
  if (process.env.PACES_ASYNC === '1') {
    const CAP = 1 << 19;
    const time = new Float64Array(CAP);
    const ids = new Uint32Array(CAP);
    const triggers = new Uint32Array(CAP);
    const phases = new Uint8Array(CAP);
    const kinds = new Uint16Array(CAP);
    const typeIndex = new Map<string, number>();
    const typeNames: string[] = [];
    let count = 0;
    const record = (phase: number, asyncId: number, trigger: number, kind: number): void => {
      const i = count++ % CAP;
      time[i] = performance.now();
      ids[i] = asyncId;
      triggers[i] = trigger;
      phases[i] = phase;
      kinds[i] = kind;
    };
    const hook = createHook({
      init(asyncId, type, triggerAsyncId) {
        let k = typeIndex.get(type);
        if (k === undefined) {
          k = typeNames.length;
          typeNames.push(type);
          typeIndex.set(type, k);
        }
        record(0, asyncId, triggerAsyncId, k);
      },
      before(asyncId) {
        record(1, asyncId, 0, 0);
      },
      after(asyncId) {
        record(2, asyncId, 0, 0);
      },
    });
    hook.enable();
    const PHASES = ['init', 'before', 'after'] as const;
    drainAsync = () => {
      hook.disable();
      const n = Math.min(count, CAP);
      const first = count > CAP ? count % CAP : 0;
      for (let j = 0; j < n; j++) {
        const i = (first + j) % CAP;
        const phase = PHASES[phases[i] as number] ?? 'init';
        events.push({
          type: 'async',
          time: t0 + (time[i] as number),
          phase,
          asyncId: ids[i] as number,
          triggerAsyncId: triggers[i] as number,
          asyncType: phase === 'init' ? (typeNames[kinds[i] as number] ?? '') : '',
        });
      }
    };
  }

  let started = false;
  const startProfiler = (): void => {
    if (started) return;
    started = true;
    session.post('Profiler.enable');
    session.post('Profiler.setSamplingInterval', { interval });
    session.post('Profiler.start');
  };
  if (process.env.PACES_DEFER !== '1') startProfiler();

  let flushed = false;
  const flush = (): void => {
    if (flushed) return;
    flushed = true;
    try {
      // On the main thread the inspector dispatches synchronously, so this works in `exit`.
      let profile: unknown;
      session.post('Profiler.stop', (err, result) => {
        if (!err) profile = (result as { profile: unknown }).profile;
      });
      drainAsync();
      // Keeping the Debugger domain enabled slows promise-heavy code about 9x (V8 instruments every
      // promise). Enabling it here replays `scriptParsed` for every live script, which is all we need.
      session.post('Debugger.enable');
      session.post('Debugger.disable');
      clearInterval(loopTimer);
      histogram.disable();
      gcObserver.takeRecords();
      const raw = join(dir, 'raw');
      mkdirSync(raw, { recursive: true });
      if (profile) writeFileSync(join(raw, `${track}.cpuprofile`), JSON.stringify(profile));
      writeFileSync(
        join(raw, `${track}.info`),
        JSON.stringify({
          pid: process.pid,
          threadId,
          parent: isMainThread ? parentTrack : `p${process.pid}`,
          argv: process.argv,
          cwd: process.cwd(),
        }),
      );
      writeFileSync(join(raw, `${track}.scripts`), JSON.stringify(scripts));
      writeFileSync(join(raw, `${track}.events`), events.map((e) => JSON.stringify(e)).join('\n'));
    } catch {
      // Never break the target because the profiler could not write.
    }
  };

  process.on('exit', flush);

  // Default SIGINT would end the process without running `exit` handlers, losing the profile.
  // Exit with the conventional code unless the app installed its own handler.
  if (isMainThread) {
    process.on('SIGINT', () => {
      if (process.listenerCount('SIGINT') <= 1) process.exit(130);
    });
  }

  const socketPath = process.env.PACES_SOCKET;
  if (socketPath) {
    const socket = connect(socketPath);
    socket.on('error', () => {});
    socket.unref();
    const send = (m: object): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(m)}\n`);
    };
    // Looking at `process.stdin` (`.isTTY`, as npx and many CLIs do) does not read the keyboard;
    // starting to read does, and that is what the CLI needs to know. Both ways in, `resume` (data
    // listeners, pipe) and `read` (readable listeners, iteration), go through the instance, so the
    // first call is reported and the wrappers removed.
    const stdinGet = Object.getOwnPropertyDescriptor(process, 'stdin');
    const readStdin = stdinGet?.get;
    if (isMainThread && stdinGet?.configurable && readStdin) {
      let watched = false;
      Object.defineProperty(process, 'stdin', {
        ...stdinGet,
        get() {
          const stream: NodeJS.ReadStream = readStdin.call(process);
          if (!watched) {
            watched = true;
            const names = ['resume', 'read'] as const;
            for (const name of names) {
              const original = stream[name] as (...args: unknown[]) => unknown;
              Object.defineProperty(stream, name, {
                configurable: true,
                writable: true,
                value(this: unknown, ...args: unknown[]) {
                  for (const n of names) delete (stream as unknown as Record<string, unknown>)[n];
                  send({ type: 'stdin' });
                  return original.apply(this, args);
                },
              });
            }
          }
          return stream;
        },
      });
    }
    socket.on('connect', () =>
      send({
        type: 'register',
        track,
        pid: process.pid,
        threadId,
        argv: process.argv,
        cwd: process.cwd(),
        node: process.version,
        interval,
        start: Date.now(),
      }),
    );
    let buf = '';
    socket.on('data', (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg: { type?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === 'start') startProfiler();
        else if (msg.type === 'stop') {
          flush();
          send({ type: 'flushed', track });
        } else if (msg.type === 'sigint' && isMainThread) process.emit('SIGINT', 'SIGINT');
      }
    });
  }
}

start();
