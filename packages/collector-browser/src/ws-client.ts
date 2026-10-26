import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WsConnection {
  send(text: string): void;
  onMessage(handler: (text: string) => void): void;
  /** Called once, when the connection ends for any reason. */
  onClose(handler: () => void): void;
  /** Says goodbye and ends the connection; the other side keeps running. */
  close(): void;
}

/** A client frame: always masked. */
function clientFrame(opcode: number, payload: Buffer): Buffer {
  const head: number[] = [0x80 | opcode];
  if (payload.length < 126) head.push(0x80 | payload.length);
  else if (payload.length < 65_536)
    head.push(0x80 | 126, payload.length >> 8, payload.length & 0xff);
  else {
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(payload.length));
    head.push(0x80 | 127, ...len);
  }
  const mask = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] = (body[i] ?? 0) ^ (mask[i % 4] ?? 0);
  return Buffer.concat([Buffer.from(head), mask, body]);
}

/**
 * A minimal WebSocket client over a plain TCP socket, for a debugging port on this machine (Node 20
 * has no WebSocket of its own). Text frames, ping and close; no compression, no TLS.
 */
export function connectWebSocket(url: string, timeoutMs = 10_000): Promise<WsConnection> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'ws:') {
      reject(
        new Error(`Only ws:// addresses on this machine are supported, not ${target.protocol}//.`),
      );
      return;
    }
    const host = target.hostname;
    const port = Number(target.port) || 80;
    const socket = connect({ host, port });
    const key = randomBytes(16).toString('base64');
    const closers: Array<() => void> = [];
    const readers: Array<(text: string) => void> = [];
    let closedAlready = false;
    let upgraded = false;

    const notifyClosed = (): void => {
      if (closedAlready) return;
      closedAlready = true;
      for (const h of closers) h();
    };
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `${host}:${port} did not answer the WebSocket handshake within ${timeoutMs / 1000} s.`,
        ),
      );
    }, timeoutMs);

    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (!upgraded) {
        reject(
          new Error(
            error.code === 'ECONNREFUSED'
              ? `Nothing is listening on ${host}:${port}.`
              : `Could not connect to ${host}:${port}: ${error.message}`,
          ),
        );
      }
      notifyClosed();
    });
    socket.on('close', notifyClosed);

    socket.write(
      `GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );

    let head = Buffer.alloc(0);
    let pending: Buffer[] = [];
    let pendingSize = 0;
    let needed = 2;
    let fragments: Buffer[] = [];

    const frameSize = (buf: Buffer): number => {
      if (buf.length < 2) return 2;
      const len = (buf[1] ?? 0) & 0x7f;
      if (len < 126) return 2 + len;
      if (len === 126) return buf.length < 4 ? 4 : 4 + buf.readUInt16BE(2);
      return buf.length < 10 ? 10 : 10 + Number(buf.readBigUInt64BE(2));
    };

    const onFrame = (opcode: number, fin: boolean, payload: Buffer): void => {
      if (opcode === 9) socket.write(clientFrame(0xa, payload));
      else if (opcode === 8) {
        socket.write(clientFrame(8, Buffer.alloc(0)));
        socket.end();
      } else if (opcode === 1 || opcode === 2 || opcode === 0) {
        fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(fragments).toString('utf8');
          fragments = [];
          for (const h of readers) h(text);
        }
      }
    };

    const read = (chunk: Buffer): void => {
      pending.push(chunk);
      pendingSize += chunk.length;
      if (pendingSize < needed) return;
      let buf = Buffer.concat(pending);
      pending = [];
      for (;;) {
        const total = frameSize(buf);
        if (buf.length < total) break;
        const first = buf[0] ?? 0;
        const len7 = (buf[1] ?? 0) & 0x7f;
        const offset = len7 < 126 ? 2 : len7 === 126 ? 4 : 10;
        onFrame(first & 0x0f, (first & 0x80) !== 0, buf.subarray(offset, total));
        buf = buf.subarray(total);
        if (buf.length === 0) break;
      }
      pending = buf.length > 0 ? [buf] : [];
      pendingSize = buf.length;
      needed = buf.length > 0 ? frameSize(buf) : 2;
    };

    socket.on('data', (chunk: Buffer) => {
      if (upgraded) return read(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      const header = head.subarray(0, end).toString('utf8');
      const status = /^HTTP\/1\.1 (\d{3})/.exec(header)?.[1];
      clearTimeout(timer);
      if (status !== '101') {
        socket.destroy();
        reject(
          new Error(
            `${host}:${port} refused the WebSocket connection (HTTP ${status ?? 'unknown'}). A browser started with --remote-debugging-port accepts it only from this machine.`,
          ),
        );
        return;
      }
      const expected = createHash('sha1')
        .update(key + GUID)
        .digest('base64');
      const accept = /^sec-websocket-accept:\s*(.+)$/im.exec(header)?.[1]?.trim();
      if (accept !== expected) {
        socket.destroy();
        reject(new Error(`${host}:${port} gave a WebSocket handshake answer that does not match.`));
        return;
      }
      upgraded = true;
      resolve({
        send: (text) => void socket.write(clientFrame(1, Buffer.from(text, 'utf8'))),
        onMessage: (handler) => void readers.push(handler),
        onClose: (handler) => {
          if (closedAlready) handler();
          else closers.push(handler);
        },
        close: () => {
          socket.write(clientFrame(8, Buffer.alloc(0)));
          socket.end();
        },
      });
      const rest = head.subarray(end + 4);
      if (rest.length > 0) read(rest);
    });
  });
}
