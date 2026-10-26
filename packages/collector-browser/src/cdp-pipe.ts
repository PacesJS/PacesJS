import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';

export interface CdpEvent {
  method: string;
  params?: unknown;
  sessionId?: string;
}

/** The part of a client the session code needs; tests stand in for the browser here. */
export type CdpLike = Pick<CdpClient, 'send' | 'onEvent' | 'closed'>;

export interface CdpClient {
  send(method: string, params?: object, sessionId?: string): Promise<unknown>;
  onEvent(handler: (event: CdpEvent) => void): void;
  /** Resolves when the browser end of the pipe closes. */
  closed: Promise<void>;
}

export interface CdpClientOptions {
  /** Replies from the browser (fd 4). */
  input: Readable;
  /** Commands to the browser (fd 3). */
  output: Writable;
  timeoutMs?: number;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Reply {
  id?: number;
  result?: unknown;
  error?: { message?: string };
  method?: string;
}

/** CDP over `--remote-debugging-pipe`: NUL-delimited UTF-8 JSON in both directions. */
export function createCdpClient(options: CdpClientOptions): CdpClient {
  const { input, output, timeoutMs = 20_000 } = options;
  const pending = new Map<number, Pending>();
  const listeners: ((event: CdpEvent) => void)[] = [];
  const decoder = new StringDecoder('utf8');
  let nextId = 1;
  let buffer = '';
  let isClosed = false;
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const dispatch = (raw: string): void => {
    let message: Reply;
    try {
      message = JSON.parse(raw) as Reply;
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(`${entry.method}: ${message.error.message ?? 'failed'}`));
      } else entry.resolve(message.result);
    } else if (message.method !== undefined) {
      for (const listener of listeners) listener(message as CdpEvent);
    }
  };

  const close = (): void => {
    if (isClosed) return;
    isClosed = true;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`${entry.method}: the browser pipe closed`));
      pending.delete(id);
    }
    markClosed();
  };

  input.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let end = buffer.indexOf('\0');
    while (end >= 0) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (raw) dispatch(raw);
      end = buffer.indexOf('\0');
    }
  });
  input.on('end', close);
  input.on('close', close);
  input.on('error', close);
  output.on('error', close);

  return {
    closed,
    onEvent: (handler) => {
      listeners.push(handler);
    },
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        if (isClosed) {
          reject(new Error(`${method}: the browser pipe is closed`));
          return;
        }
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method}: no reply from the browser within ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(id, { method, resolve, reject, timer });
        const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
        output.write(JSON.stringify(message) + '\0');
      }),
  };
}
