import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRecording } from '../src/recorder.js';
// @ts-expect-error the zoo server is plain JavaScript
import { startZoo } from '../../../zoo/browser/server.mjs';

// Needs a real Chromium: PACES_BROWSER=<path to chrome.exe | msedge.exe | chrome>.
const exe = process.env.PACES_BROWSER;

interface Zoo {
  url(page: string): string;
  close(): Promise<unknown>;
}

describe.runIf(exe)('startRecording (real browser)', () => {
  let zoo: Zoo;
  beforeAll(async () => {
    zoo = (await startZoo()) as Zoo;
  });
  afterAll(async () => {
    await zoo.close();
  });

  it('keeps the trace when the user closes the window, and says that is how it ended', async () => {
    const run = await startRecording({
      url: zoo.url('slow-click'),
      exe: exe ?? '',
      screenshots: true,
      startPaused: false,
      fullTrace: false,
      keepQuery: false,
      hiRes: false,
      overlay: true,
      eventMarks: true,
      eventText: true,
      cacheCold: false,
    });
    // Wait for the page's own click (a mark), then close every page as the user closing the window does.
    const end = Date.now() + 20_000;
    while (!run.controller.state().marks && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 100));
      if (run.controller.state().elapsedMs > 3000) break;
    }
    const { targetInfos } = (await run.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string }>;
    };
    for (const t of targetInfos.filter((x) => x.type === 'page')) {
      await run.cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => undefined);
    }
    const recording = await run.done;
    expect(recording.endedBy).toBe('window-closed');
    expect(recording.events.filter((e) => e.name === 'ProfileChunk').length).toBeGreaterThan(0);
    expect(recording.warnings.map((w) => w.kind)).not.toContain('trace-incomplete');
    expect(recording.sources.some((x) => x.text.includes('busy(220)'))).toBe(true);
  }, 60_000);
});
