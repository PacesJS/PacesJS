import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Control socket path for a session: a named pipe on Windows, a Unix socket elsewhere. */
export function socketPath(sessionId: string): string {
  return process.platform === 'win32'
    ? String.raw`\\.\pipe\paces-${sessionId}`
    : join(tmpdir(), `paces-${sessionId}.sock`);
}

/** Messages sent from a profiled process to the CLI. */
export type ToCli =
  | {
      type: 'register';
      track: string;
      pid: number;
      threadId: number;
      argv: string[];
      cwd: string;
      node: string;
      interval: number;
      start: number;
    }
  | { type: 'flushed'; track: string }
  /** The program touched `process.stdin`, so it may want the keyboard for itself. */
  | { type: 'stdin' };

/** Messages sent from the CLI to a profiled process. */
export type ToTarget = { type: 'start' } | { type: 'stop' } | { type: 'sigint' };
