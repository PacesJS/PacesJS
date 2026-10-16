import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { socketPath } from '../src/protocol.js';
import { newSessionDir, PRELOAD_CJS } from './helpers/run.js';

interface Msg {
  type: string;
  [k: string]: unknown;
}

class Controller {
  server: Server;
  sockets: Socket[] = [];
  messages: Msg[] = [];
  waiters: Array<{ type: string; resolve: (m: Msg) => void }> = [];
  constructor(public path: string) {
    this.server = createServer((s) => {
      this.sockets.push(s);
      let buf = '';
      s.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const m = JSON.parse(line) as Msg;
          this.messages.push(m);
          this.waiters = this.waiters.filter((w) =>
            w.type === m.type ? (w.resolve(m), false) : true,
          );
        }
      });
      s.on('error', () => {});
    });
  }
  listen(): Promise<void> {
    return new Promise((r) => this.server.listen(this.path, r));
  }
  next(type: string, ms = 5000): Promise<Msg> {
    const have = this.messages.find((m) => m.type === type);
    if (have) return Promise.resolve(have);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
      this.waiters.push({ type, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }
  send(m: Msg): void {
    for (const s of this.sockets) s.write(JSON.stringify(m) + '\n');
  }
  close(): void {
    for (const s of this.sockets) s.destroy();
    this.server.close();
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

async function launch(code: string, id: string) {
  const dir = newSessionDir();
  const ctl = new Controller(socketPath(id));
  await ctl.listen();
  const preload = new URL(PRELOAD_CJS).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const child: ChildProcess = spawn(process.execPath, ['-e', code], {
    env: {
      ...process.env,
      NODE_OPTIONS: `--require "${preload}"`,
      PACES_DIR: dir,
      PACES_SESSION: id,
      PACES_SOCKET: ctl.path,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout!.on('data', (d) => (stdout += d));
  const exited = new Promise<number | null>((r) => child.on('close', (c) => r(c)));
  cleanups.push(() => {
    child.kill();
    ctl.close();
  });
  return { dir, ctl, child, exited, out: () => stdout };
}

const SERVER = `setInterval(()=>{let x=0;for(let i=0;i<2e5;i++)x+=i},5)`;

describe('control socket', () => {
  it('registers each process as a track', async () => {
    const t = await launch(SERVER, `reg-${process.pid}`);
    const m = await t.ctl.next('register');
    expect(m.pid).toBe(t.child.pid);
    expect(String(m.track)).toBe(`p${t.child.pid}`);
    expect(m.threadId).toBe(0);
  });

  it('flushes the profile on `stop` while the app keeps running', async () => {
    const t = await launch(SERVER, `stop-${process.pid}`);
    await t.ctl.next('register');
    await new Promise((r) => setTimeout(r, 300));
    t.ctl.send({ type: 'stop' });
    const ack = await t.ctl.next('flushed');
    expect(existsSync(join(t.dir, 'raw', `${ack.track}.cpuprofile`))).toBe(true);
    expect(t.child.exitCode).toBeNull();
  });

  it('`sigint` ends an app that has no handler, with exit code 130, and still flushes', async () => {
    const t = await launch(SERVER, `sig-${process.pid}`);
    await t.ctl.next('register');
    await new Promise((r) => setTimeout(r, 300));
    t.ctl.send({ type: 'sigint' });
    expect(await t.exited).toBe(130);
    expect(existsSync(join(t.dir, 'raw', `p${t.child.pid}.cpuprofile`))).toBe(true);
  });

  it("`sigint` runs the app's own SIGINT handler instead of exiting", async () => {
    const code = `process.on('SIGINT',()=>{console.log('graceful');setTimeout(()=>process.exit(0),50)});${SERVER}`;
    const t = await launch(code, `hnd-${process.pid}`);
    await t.ctl.next('register');
    t.ctl.send({ type: 'sigint' });
    expect(await t.exited).toBe(0);
    expect(t.out()).toContain('graceful');
  });

  it('runs normally when the control socket is unreachable', async () => {
    const dir = newSessionDir();
    const preload = new URL(PRELOAD_CJS).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const child = spawn(process.execPath, ['-e', 'console.log("ok")'], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require "${preload}"`,
        PACES_DIR: dir,
        PACES_SOCKET: socketPath('nobody-home'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout!.on('data', (d) => (out += d));
    const code = await new Promise((r) => child.on('close', r));
    expect(code).toBe(0);
    expect(out.trim()).toBe('ok');
    expect(existsSync(join(dir, 'raw'))).toBe(true);
  });
});
