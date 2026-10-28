// Loads the preload inside the test process, so what it does is measured by coverage. The spawned
// runs in preload.test.ts and control.test.ts prove it works in a real child; these prove each branch.
import { createServer as createHttpServer, Server as HttpServer } from 'node:http';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { socketPath } from '../src/protocol.js';
import { newSessionDir } from './helpers/run.js';

interface Msg {
  type: string;
  [k: string]: unknown;
}

const FLAG = Symbol.for('paces.preload.active');
const ENV_KEYS = [
  'PACES_DIR',
  'PACES_SOCKET',
  'PACES_INTERVAL',
  'PACES_DEFER',
  'PACES_ASYNC',
  'PACES_PARENT',
  'PACES_V8_TRACE',
];

let dir: string;
let before: { exit: Array<() => void>; sigint: Array<() => void> };
let server: Server | undefined;
let sockets: Socket[] = [];
let messages: Msg[] = [];
let waiters: Array<{ type: string; resolve: (m: Msg) => void }> = [];

const originalEmit = HttpServer.prototype.emit;
const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');

function waitFor(type: string): Promise<Msg> {
  const seen = messages.find((m) => m.type === type);
  if (seen) return Promise.resolve(seen);
  return new Promise((resolve) => waiters.push({ type, resolve }));
}

async function listen(path: string): Promise<void> {
  server = createServer((s) => {
    sockets.push(s);
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const m = JSON.parse(buf.slice(0, i)) as Msg;
        buf = buf.slice(i + 1);
        messages.push(m);
        waiters = waiters.filter((w) => (w.type === m.type ? (w.resolve(m), false) : true));
      }
    });
    s.on('error', () => {});
  });
  await new Promise<void>((resolve) => server?.listen(path, resolve));
}

/** Starts the preload as a fresh process would, optionally with a control socket. */
async function load(env: Record<string, string> = {}, withSocket = true): Promise<void> {
  process.env.PACES_DIR = dir;
  if (withSocket) {
    const path = socketPath(`inproc-${process.pid}-${Date.now()}`);
    await listen(path);
    process.env.PACES_SOCKET = path;
  }
  Object.assign(process.env, env);
  (globalThis as Record<symbol, unknown>)[FLAG] = undefined;
  vi.resetModules();
  await import('../src/preload.js');
}

const send = (m: object): void => {
  for (const s of sockets) s.write(`${JSON.stringify(m)}\n`);
};

async function stop(): Promise<void> {
  await waitFor('register');
  send({ type: 'stop' });
  await waitFor('flushed');
}

const raw = (name: string): string => readFileSync(join(dir, 'raw', name), 'utf8');
const rawNamed = (ext: string): string => {
  const track = `p${process.pid}`;
  return raw(`${track}.${ext}`);
};

beforeEach(() => {
  before = { exit: process.listeners('exit'), sigint: process.listeners('SIGINT') };
  dir = newSessionDir();
  messages = [];
  waiters = [];
  sockets = [];
});

afterEach(async () => {
  for (const s of sockets) s.destroy();
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = undefined;
  for (const key of ENV_KEYS) delete process.env[key];
  HttpServer.prototype.emit = originalEmit;
  if (stdinDescriptor) Object.defineProperty(process, 'stdin', stdinDescriptor);
  (globalThis as Record<symbol, unknown>)[FLAG] = undefined;
  // Each load adds its own handlers; leaving them would stack across tests.
  for (const l of process.listeners('exit'))
    if (!before.exit.includes(l)) process.off('exit', l as () => void);
  for (const l of process.listeners('SIGINT'))
    if (!before.sigint.includes(l)) process.off('SIGINT', l as () => void);
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('preload in this process', () => {
  it('does nothing without PACES_DIR, and only once per process', async () => {
    delete process.env.PACES_DIR;
    (globalThis as Record<symbol, unknown>)[FLAG] = undefined;
    vi.resetModules();
    await import('../src/preload.js');
    expect((globalThis as Record<symbol, unknown>)[FLAG]).toBeUndefined();

    await load({}, false);
    const patched = HttpServer.prototype.emit;
    vi.resetModules();
    await import('../src/preload.js');
    expect(HttpServer.prototype.emit).toBe(patched);
  });

  it('registers on connect and writes the profile, info, scripts and events on stop', async () => {
    await load();
    const register = await waitFor('register');
    expect(register).toMatchObject({ track: `p${process.pid}`, pid: process.pid, threadId: 0 });
    await stop();

    const profile = JSON.parse(rawNamed('cpuprofile')) as { nodes: unknown[] };
    expect(profile.nodes.length).toBeGreaterThan(0);
    const info = JSON.parse(rawNamed('info')) as { pid: number; cwd: string };
    expect(info).toMatchObject({ pid: process.pid, cwd: process.cwd() });
    const scripts = JSON.parse(rawNamed('scripts')) as Array<{ url: string }>;
    expect(scripts.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, 'raw', `p${process.pid}.events`))).toBe(true);
  });

  it('hands its track to the children it starts, and links to the track it was started under', async () => {
    await load({ PACES_PARENT: 'p1' });
    expect(process.env.PACES_PARENT).toBe(`p${process.pid}`);
    await stop();
    expect((JSON.parse(rawNamed('info')) as { parent: string }).parent).toBe('p1');
  });

  it('waits for the start message when deferred', async () => {
    await load({ PACES_DEFER: '1' });
    await waitFor('register');
    send({ type: 'start' });
    send({ type: 'start' });
    await stop();
    expect(JSON.parse(rawNamed('cpuprofile'))).toHaveProperty('samples');
  });

  it('writes nothing for the profile when it never started, and the other files still land', async () => {
    await load({ PACES_DEFER: '1' });
    await stop();
    expect(existsSync(join(dir, 'raw', `p${process.pid}.cpuprofile`))).toBe(false);
    expect(existsSync(join(dir, 'raw', `p${process.pid}.info`))).toBe(true);
  });

  it('labels an http request with its method, path without query, and status', async () => {
    await load();
    const http = createHttpServer((_req, res) => {
      res.statusCode = 201;
      res.end('ok');
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const address = http.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/orders?secret=1`, { method: 'POST' });
    await response.text();
    await new Promise((r) => http.close(r));
    await stop();

    const events = rawNamed('events')
      .split('\n')
      .map((l) => JSON.parse(l) as Msg);
    const request = events.find((e) => e.type === 'request');
    expect(request).toMatchObject({ method: 'POST', url: '/orders', status: 201 });
  });

  it('records async causality only when asked (--async)', async () => {
    await load({ PACES_ASYNC: '1' });
    await new Promise((r) => setTimeout(r, 5));
    await stop();
    const events = rawNamed('events')
      .split('\n')
      .map((l) => JSON.parse(l) as Msg);
    const init = events.find((e) => e.type === 'async' && e.phase === 'init');
    expect(init).toBeDefined();
    expect(typeof init?.asyncType).toBe('string');
    expect(events.some((e) => e.type === 'async' && e.phase === 'before')).toBe(true);
  });

  it('records no async events by default', async () => {
    await load();
    await new Promise((r) => setTimeout(r, 5));
    await stop();
    const events = rawNamed('events').split('\n');
    expect(events.some((l) => l.includes('"type":"async"'))).toBe(false);
  });

  it('samples the event loop on a timer', async () => {
    await load();
    await waitFor('register');
    await new Promise((r) => setTimeout(r, 250));
    await stop();
    expect(rawNamed('events')).toContain('"type":"loop"');
  });

  it('tells the CLI when the program first reads stdin, and only once', async () => {
    await load();
    await waitFor('register');
    void process.stdin;
    process.stdin.resume();
    process.stdin.pause();
    process.stdin.resume();
    process.stdin.pause();
    await waitFor('stdin');
    await stop();
    expect(messages.filter((m) => m.type === 'stdin')).toHaveLength(1);
  });

  it('exits with 130 on a forwarded Ctrl+C unless the app handles SIGINT itself', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const others = process.listeners('SIGINT');
    process.removeAllListeners('SIGINT');
    await load();
    await waitFor('register');
    send({ type: 'sigint' });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
    for (const l of others) process.on('SIGINT', l as () => void);
  });

  it('leaves SIGINT to the app when it installed its own handler', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const own = vi.fn();
    process.on('SIGINT', own);
    await load();
    await waitFor('register');
    send({ type: 'sigint' });
    await vi.waitFor(() => expect(own).toHaveBeenCalled());
    expect(exit).not.toHaveBeenCalled();
    process.off('SIGINT', own);
  });

  it('ignores a line that is not JSON and keeps listening', async () => {
    await load();
    await waitFor('register');
    for (const s of sockets) s.write('not json\n');
    await stop();
    expect(existsSync(join(dir, 'raw', `p${process.pid}.info`))).toBe(true);
  });

  it('never breaks the program when the profile cannot be written', async () => {
    await load();
    await waitFor('register');
    rmSync(dir, { recursive: true, force: true });
    await import('node:fs').then((fs) => {
      fs.writeFileSync(dir, 'a file where the session directory should be');
    });
    send({ type: 'stop' });
    await waitFor('flushed');
    rmSync(dir, { force: true });
  });
});
