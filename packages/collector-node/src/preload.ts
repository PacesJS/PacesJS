// Injected into every Node process of the target through NODE_OPTIONS (--require).
// Runs inside the user's process: keep it small, dependency-free and behavior-neutral.
import { connect } from 'node:net';
import { Session } from 'node:inspector';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  | { type: 'loop'; time: number; p50: number; p99: number; max: number };

const FLAG = Symbol.for('paces.preload.active');

function start(): void {
  const dir = process.env.PACES_DIR;
  const g = globalThis as Record<symbol, unknown>;
  if (!dir || g[FLAG]) return;
  g[FLAG] = true;

  const interval = Number(process.env.PACES_INTERVAL) || 1000;
  const track = isMainThread ? `p${process.pid}` : `p${process.pid}-w${threadId}`;
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

  let started = false;
  const startProfiler = (): void => {
    if (started) return;
    started = true;
    session.post('Debugger.enable');
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
      clearInterval(loopTimer);
      histogram.disable();
      gcObserver.takeRecords();
      const raw = join(dir, 'raw');
      mkdirSync(raw, { recursive: true });
      if (profile) writeFileSync(join(raw, `${track}.cpuprofile`), JSON.stringify(profile));
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
