import { afterEach, describe, expect, it } from 'vitest';
import { connectWebSocket } from '../src/ws-client.js';
import { serverFrame, startTestWsServer, textFrame } from './helpers/ws-server.js';
import type { TestWsServer } from './helpers/ws-server.js';

let server: TestWsServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const url = (s: TestWsServer): string => `ws://127.0.0.1:${s.port}/devtools/browser/abc`;

async function open() {
  server = await startTestWsServer();
  const accepted = server.next();
  const ws = await connectWebSocket(url(server));
  const peer = await accepted;
  const messages: string[] = [];
  ws.onMessage((m) => messages.push(m));
  return { ws, peer, messages };
}

const until = async (condition: () => boolean): Promise<void> => {
  const end = Date.now() + 5000;
  while (!condition() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  if (!condition()) throw new Error('timed out waiting');
};

describe('connectWebSocket', () => {
  it('sends text to the server, masked as a client must', async () => {
    const { ws, peer } = await open();
    ws.send('{"id":1}');
    await until(() => peer.received.length === 1);
    expect(peer.received).toEqual(['{"id":1}']);
  });

  it('delivers text the server sends', async () => {
    const { peer, messages } = await open();
    peer.send(textFrame('hello'));
    await until(() => messages.length === 1);
    expect(messages).toEqual(['hello']);
  });

  it('delivers several messages that arrive in one write', async () => {
    const { peer, messages } = await open();
    peer.send(Buffer.concat([textFrame('a'), textFrame('b'), textFrame('c')]));
    await until(() => messages.length === 3);
    expect(messages).toEqual(['a', 'b', 'c']);
  });

  it('assembles a message whose frame arrives in pieces', async () => {
    const { peer, messages } = await open();
    const frame = textFrame('split across writes');
    peer.send(frame.subarray(0, 1));
    peer.send(frame.subarray(1, 5));
    peer.send(frame.subarray(5));
    await until(() => messages.length === 1);
    expect(messages).toEqual(['split across writes']);
  });

  it.each([100, 300, 70_000])('reads a message of %i bytes', async (size) => {
    const { peer, messages } = await open();
    const text = 'x'.repeat(size);
    peer.send(textFrame(text));
    await until(() => messages.length === 1);
    expect(messages[0]).toBe(text);
  });

  it('sends a large message too', async () => {
    const { ws, peer } = await open();
    const text = JSON.stringify({ blob: 'y'.repeat(80_000) });
    ws.send(text);
    await until(() => peer.received.length === 1);
    expect(peer.received[0]).toBe(text);
  });

  it('joins a message the server fragmented, and a character split between fragments', async () => {
    const { peer, messages } = await open();
    const bytes = Buffer.from('é→😀');
    peer.send(serverFrame(1, bytes.subarray(0, 1), false));
    peer.send(serverFrame(0, bytes.subarray(1, 4), false));
    peer.send(serverFrame(0, bytes.subarray(4), true));
    await until(() => messages.length === 1);
    expect(messages).toEqual(['é→😀']);
  });

  it('answers a ping with a pong carrying the same bytes', async () => {
    const { peer } = await open();
    peer.send(serverFrame(9, Buffer.from('are you there')));
    await until(() => peer.pongs.length === 1);
    expect(peer.pongs).toEqual(['are you there']);
  });

  it('tells the listener when the server closes the connection', async () => {
    const { ws, peer } = await open();
    let closed = false;
    ws.onClose(() => {
      closed = true;
    });
    peer.socket.end();
    await until(() => closed);
    expect(closed).toBe(true);
  });

  it('closes the connection when asked, and says so', async () => {
    const { ws } = await open();
    let closed = false;
    ws.onClose(() => {
      closed = true;
    });
    ws.close();
    await until(() => closed);
    expect(closed).toBe(true);
  });

  it('refuses a server that does not upgrade, naming what it said', async () => {
    server = await startTestWsServer({ refuse: 403 });
    await expect(connectWebSocket(url(server))).rejects.toThrow(/403/);
  });

  it('refuses a server whose handshake answer is wrong', async () => {
    server = await startTestWsServer({ badAccept: true });
    await expect(connectWebSocket(url(server))).rejects.toThrow(/handshake/i);
  });

  it('says what to do when nothing is listening', async () => {
    server = await startTestWsServer();
    const port = server.port;
    await server.close();
    server = undefined;
    await expect(connectWebSocket(`ws://127.0.0.1:${port}/x`)).rejects.toThrow(/127\.0\.0\.1/);
  });
});
