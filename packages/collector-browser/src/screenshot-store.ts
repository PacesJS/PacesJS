import { createHash } from 'node:crypto';

export interface ScreenshotFrame {
  id: number;
  tsUs: number;
  hash: string;
  bytes: Uint8Array;
}

export interface ScreenshotResult {
  frames: ScreenshotFrame[];
  /** Consecutive identical frames that were not stored. */
  deduplicated: number;
  cap: number;
}

export interface ScreenshotStoreOptions {
  /** Most frames kept in the session. */
  cap: number;
  maxBytes: number;
}

export interface ScreenshotStore {
  add(tsUs: number, bytes: Uint8Array): void;
  finish(): ScreenshotResult;
}

type Held = Omit<ScreenshotFrame, 'id'>;

/** Keeps `count` frames spread evenly by position, always including the first and the last. */
function spread(frames: Held[], count: number): Held[] {
  if (frames.length <= count) return frames;
  if (count <= 1) return frames.slice(0, 1);
  const out: Held[] = [];
  for (let i = 0; i < count; i++) {
    const frame = frames[Math.round((i * (frames.length - 1)) / (count - 1))];
    if (frame) out.push(frame);
  }
  return out;
}

export function createScreenshotStore(options: ScreenshotStoreOptions): ScreenshotStore {
  let held: Held[] = [];
  let lastHash = '';
  let deduplicated = 0;

  return {
    add(tsUs, bytes) {
      const hash = createHash('sha1').update(bytes).digest('hex');
      if (hash === lastHash) {
        deduplicated++;
        return;
      }
      lastHash = hash;
      held.push({ tsUs, hash, bytes });
      // Thin while recording so a busy page cannot hold thousands of frames in memory.
      if (held.length > options.cap * 2) held = spread(held, options.cap);
    },
    finish() {
      const sorted = [...held].sort((a, b) => a.tsUs - b.tsUs);
      let count = Math.min(sorted.length, options.cap);
      let chosen = spread(sorted, count);
      const size = (list: Held[]): number => list.reduce((n, f) => n + f.bytes.length, 0);
      while (count > 2 && size(chosen) > options.maxBytes) {
        count = Math.max(2, Math.floor(count * 0.8));
        chosen = spread(sorted, count);
      }
      return {
        frames: chosen.map((f, id) => ({ id, ...f })),
        deduplicated,
        cap: options.cap,
      };
    },
  };
}
