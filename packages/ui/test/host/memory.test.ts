import { describe, expect, it } from 'vitest';
import { memoryHostAdapter } from '../../src/host/memory';

const JPEG = Uint8Array.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

describe('memoryHostAdapter: screenshots', () => {
  it('reads a frame by id', async () => {
    const host = memoryHostAdapter({ model: new Uint8Array(), screenshots: { 3: JPEG } });
    expect(await host.readScreenshot(3)).toEqual(JPEG);
  });

  it('rejects, naming the frame, for one it does not have', async () => {
    const host = memoryHostAdapter({ model: new Uint8Array() });
    await expect(host.readScreenshot(9)).rejects.toThrow(/frame 9/);
  });
});
