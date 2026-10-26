import { get } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import { createCdpClient } from './cdp-pipe.js';
import type { CdpClient } from './cdp-pipe.js';
import { connectWebSocket } from './ws-client.js';

export interface AttachedCdp extends CdpClient {
  /** Lets go of the browser without closing it. */
  disconnect(): void;
}

const NOT_A_BROWSER = (port: number): string =>
  `127.0.0.1:${port} answered, but it did not look like a Chromium browser's debugging port.`;

/**
 * Asks a browser started with `--remote-debugging-port=<port>` where its debugging socket is. Only
 * ever this machine: the address the browser reports is rewritten to loopback.
 */
export function discoverBrowserSocket(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = get(
      { host: '127.0.0.1', port, path: '/json/version', timeout: 5000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          try {
            const found = (JSON.parse(body) as { webSocketDebuggerUrl?: unknown })
              .webSocketDebuggerUrl;
            if (res.statusCode !== 200 || typeof found !== 'string') throw new Error('no socket');
            resolve(`ws://127.0.0.1:${port}${new URL(found).pathname}`);
          } catch {
            reject(new Error(NOT_A_BROWSER(port)));
          }
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error: NodeJS.ErrnoException) =>
      reject(
        new Error(
          error.code === 'ECONNREFUSED'
            ? `Nothing is listening on 127.0.0.1:${port}. Start the browser with --remote-debugging-port=${port} (and --user-data-dir=<a folder>), then try again.`
            : `Could not reach 127.0.0.1:${port}: ${error.message}`,
        ),
      ),
    );
  });
}

/** CDP over a WebSocket, through the same client as the pipe: messages are NUL-framed on the way in and out. */
export async function connectCdp(url: string): Promise<AttachedCdp> {
  const ws = await connectWebSocket(url);
  const input = new PassThrough();
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const message of chunk.toString('utf8').split('\0')) if (message) ws.send(message);
      done();
    },
  });
  ws.onMessage((text) => void input.write(`${text}\0`));
  ws.onClose(() => void input.end());
  return { ...createCdpClient({ input, output }), disconnect: () => ws.close() };
}
