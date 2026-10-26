import { describe, expect, it } from 'vitest';
import { createScreenshotStore } from '../src/screenshot-store.js';

const jpeg = (n: number): Uint8Array => Uint8Array.from([0xff, 0xd8, n, n, 0xff, 0xd9]);

describe('createScreenshotStore', () => {
  it('drops a frame identical to the one before it and counts it', () => {
    const store = createScreenshotStore({ cap: 100, maxBytes: 1e6 });
    store.add(1000, jpeg(1));
    store.add(2000, jpeg(1));
    store.add(3000, jpeg(2));
    const result = store.finish();
    expect(result.frames.map((f) => f.epochMs)).toEqual([1000, 3000]);
    expect(result.deduplicated).toBe(1);
  });

  it('keeps a repeated image that is not consecutive', () => {
    const store = createScreenshotStore({ cap: 100, maxBytes: 1e6 });
    store.add(1, jpeg(1));
    store.add(2, jpeg(2));
    store.add(3, jpeg(1));
    expect(store.finish().frames).toHaveLength(3);
  });

  it('thins to the cap by keeping every Nth frame and always the first and last', () => {
    const store = createScreenshotStore({ cap: 5, maxBytes: 1e6 });
    for (let i = 0; i < 20; i++) store.add(i * 1000, jpeg(i));
    const frames = store.finish().frames;
    expect(frames.length).toBeLessThanOrEqual(5);
    expect(frames[0]?.epochMs).toBe(0);
    expect(frames[frames.length - 1]?.epochMs).toBe(19_000);
  });

  it('thins to the byte cap', () => {
    const store = createScreenshotStore({ cap: 100, maxBytes: 6 * 4 });
    for (let i = 0; i < 20; i++) store.add(i, jpeg(i));
    const result = store.finish();
    expect(result.frames.reduce((n, f) => n + f.bytes.length, 0)).toBeLessThanOrEqual(24);
    expect(result.frames[0]?.epochMs).toBe(0);
    expect(result.frames[result.frames.length - 1]?.epochMs).toBe(19);
  });

  it('numbers kept frames from zero in time order and records the cap', () => {
    const store = createScreenshotStore({ cap: 100, maxBytes: 1e6 });
    store.add(5, jpeg(1));
    store.add(2, jpeg(2));
    const result = store.finish();
    expect(result.frames.map((f) => [f.id, f.epochMs])).toEqual([
      [0, 2],
      [1, 5],
    ]);
    expect(result.cap).toBe(100);
  });
});
