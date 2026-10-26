import { afterEach, describe, expect, it } from 'vitest';
import { connectCdp, discoverBrowserSocket } from '../src/attach.js';
import { startTestWsServer, textFrame } from './helpers/ws-server.js';
import type { TestWsServer } from './helpers/ws-server.js';

let server: TestWsServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('discoverBrowserSocket', () => {
  it('reads the debugging socket of a browser that was started with a debugging port', async () => {
    server = await startTestWsServer({
      json: { Browser: 'Edg/155', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/xyz' },
    });
    await expect(discoverBrowserSocket(server.port)).resolves.toBe(
      `ws://127.0.0.1:${server.port}/devtools/browser/xyz`,
    );
  });

  it('only ever talks to this machine', async () => {
    server = await startTestWsServer({
      json: { webSocketDebuggerUrl: 'ws://203.0.113.9:9222/devtools/browser/xyz' },
    });
    const found = await discoverBrowserSocket(server.port);
    expect(found).toBe(`ws://127.0.0.1:${server.port}/devtools/browser/xyz`);
  });

  it('says how to start the browser when nothing is listening', async () => {
    server = await startTestWsServer();
    const port = server.port;
    await server.close();
    server = undefined;
    await expect(discoverBrowserSocket(port)).rejects.toThrow(
      new RegExp(`--remote-debugging-port=${port}`),
    );
  });

  it('says so when the port answers but is not a browser', async () => {
    server = await startTestWsServer();
    await expect(discoverBrowserSocket(server.port)).rejects.toThrow(/not .*browser|did not/i);
  });
});

describe('connectCdp', () => {
  async function open() {
    server = await startTestWsServer({ cdp: true });
    const accepted = server.next();
    const client = await connectCdp(`ws://127.0.0.1:${server.port}/devtools/browser/abc`);
    return { client, peer: await accepted };
  }

  it('sends a command and resolves with its result', async () => {
    const { client } = await open();
    expect(await client.send('Browser.getVersion')).toEqual({ echo: 'Browser.getVersion' });
  });

  it('delivers events', async () => {
    const { client, peer } = await open();
    const events: unknown[] = [];
    client.onEvent((e) => events.push(e));
    peer.send(textFrame(JSON.stringify({ method: 'Target.targetCreated', params: { x: 1 } })));
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual([{ method: 'Target.targetCreated', params: { x: 1 } }]);
  });

  it('resolves closed when the browser goes away', async () => {
    const { client, peer } = await open();
    peer.socket.end();
    await expect(client.closed).resolves.toBeUndefined();
  });

  it('closes the connection from our side, leaving the browser running', async () => {
    const { client, peer } = await open();
    let theirs = false;
    peer.socket.on('close', () => {
      theirs = true;
    });
    client.disconnect();
    await client.closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(theirs).toBe(true);
  });
});
