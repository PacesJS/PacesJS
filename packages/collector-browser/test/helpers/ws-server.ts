import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** A server frame (unmasked), as a browser would send it. */
export function serverFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const head: number[] = [(fin ? 0x80 : 0) | opcode];
  if (payload.length < 126) head.push(payload.length);
  else if (payload.length < 65_536) head.push(126, payload.length >> 8, payload.length & 0xff);
  else {
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(payload.length));
    head.push(127, ...len);
  }
  return Buffer.concat([Buffer.from(head), payload]);
}

export const textFrame = (text: string, fin = true): Buffer =>
  serverFrame(1, Buffer.from(text, 'utf8'), fin);

/** Frames a client sent (masked), decoded; payloads of whole frames only. */
export function readClientFrames(buffer: Buffer): {
  frames: Array<{ opcode: number; fin: boolean; payload: Buffer }>;
  rest: Buffer;
} {
  const frames: Array<{ opcode: number; fin: boolean; payload: Buffer }> = [];
  let at = 0;
  for (;;) {
    if (buffer.length - at < 2) break;
    const first = buffer[at] ?? 0;
    const second = buffer[at + 1] ?? 0;
    let length = second & 0x7f;
    let offset = at + 2;
    if (length === 126) {
      if (buffer.length - at < 4) break;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length - at < 10) break;
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    const masked = (second & 0x80) !== 0;
    const maskEnd = offset + (masked ? 4 : 0);
    if (buffer.length < maskEnd + length) break;
    const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
    const payload = Buffer.from(buffer.subarray(maskEnd, maskEnd + length));
    if (mask)
      for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
    frames.push({ opcode: first & 0x0f, fin: (first & 0x80) !== 0, payload });
    at = maskEnd + length;
  }
  return { frames, rest: buffer.subarray(at) };
}

export interface TestSocket {
  socket: Socket;
  /** Text messages the client sent. */
  received: string[];
  /** Pongs the client sent, as payload text. */
  pongs: string[];
  send(frame: Buffer): void;
}

export interface TestWsServer {
  port: number;
  /** Resolves with the next connection once it has upgraded. */
  next(): Promise<TestSocket>;
  close(): Promise<void>;
}

export interface TestWsOptions {
  /** Answer the upgrade with this HTTP status instead of 101. */
  refuse?: number;
  /** A wrong Sec-WebSocket-Accept value. */
  badAccept?: boolean;
  /** Replies to a JSON request `{id}` with `{id, result: {echo: method}}`, like a browser. */
  cdp?: boolean;
  json?: unknown;
}

export async function startTestWsServer(options: TestWsOptions = {}): Promise<TestWsServer> {
  const waiting: Array<(s: TestSocket) => void> = [];
  const ready: TestSocket[] = [];
  const server: Server = createServer((req, res) => {
    if (req.url === '/json/version' && options.json !== undefined) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(options.json));
    } else res.writeHead(404).end();
  });
  const sockets = new Set<Socket>();
  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if (options.refuse) {
      socket.end(`HTTP/1.1 ${options.refuse} Refused\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const key = String(req.headers['sec-websocket-key']);
    const accept = options.badAccept
      ? 'AAAAAAAAAAAAAAAAAAAAAAAAAAA='
      : createHash('sha1')
          .update(key + GUID)
          .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const test: TestSocket = { socket, received: [], pongs: [], send: (f) => void socket.write(f) };
    let pending: Buffer = Buffer.alloc(0);
    let message: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => {
      const { frames, rest } = readClientFrames(Buffer.concat([pending, chunk]));
      pending = rest;
      for (const f of frames) {
        if (f.opcode === 0xa) test.pongs.push(f.payload.toString('utf8'));
        else if (f.opcode === 8) socket.end(serverFrame(8, Buffer.alloc(0)));
        else if (f.opcode === 1 || f.opcode === 0) {
          message.push(f.payload);
          if (f.fin) {
            const text = Buffer.concat(message).toString('utf8');
            message = [];
            test.received.push(text);
            if (options.cdp) {
              const request = JSON.parse(text) as { id: number; method: string };
              test.send(
                textFrame(JSON.stringify({ id: request.id, result: { echo: request.method } })),
              );
            }
          }
        }
      }
    });
    const waiter = waiting.shift();
    if (waiter) waiter(test);
    else ready.push(test);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    next: () =>
      new Promise((resolve) => {
        const hit = ready.shift();
        if (hit) resolve(hit);
        else waiting.push(resolve);
      }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
