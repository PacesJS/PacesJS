import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CdpLike } from '../src/cdp-pipe.js';
import { startRecording } from '../src/recorder.js';
import type { BrowserRun } from '../src/recorder.js';
// @ts-expect-error the zoo server is plain JavaScript
import { startZoo } from '../../../zoo/browser/server.mjs';

// Needs a real Chromium: PACES_BROWSER=<path to chrome.exe | msedge.exe | chrome>.
const exe = process.env.PACES_BROWSER;

interface Zoo {
  url(page: string): string;
  close(): Promise<unknown>;
}

interface DomNode {
  nodeId: number;
  nodeName: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  nodeValue?: string;
}

const attr = (n: DomNode, name: string): string | undefined => {
  const a = n.attributes ?? [];
  for (let i = 0; i + 1 < a.length; i += 2) if (a[i] === name) return a[i + 1];
  return undefined;
};

function walk(node: DomNode, visit: (n: DomNode) => void): void {
  visit(node);
  for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) walk(child, visit);
}

const textOf = (n: DomNode): string => {
  let text = '';
  walk(n, (x) => {
    if (x.nodeName === '#text') text += x.nodeValue ?? '';
  });
  return text;
};

const until = async (condition: () => Promise<boolean> | boolean, what: string): Promise<void> => {
  const end = Date.now() + 15_000;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

/**
 * Presses a button the way a person does under a slow machine: look, and press again if nothing
 * happened yet. Each press gets a moment to show its effect first.
 */
async function pressUntil(
  press: () => Promise<void>,
  done: () => Promise<boolean> | boolean,
  what: string,
): Promise<void> {
  const end = Date.now() + 20_000;
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await press().catch(() => undefined);
    const settle = Date.now() + 1500;
    while (Date.now() < settle && !(await done())) await new Promise((r) => setTimeout(r, 100));
  }
}

/** Finds and presses things in the page the way a person does: a real mouse, at real coordinates. */
async function pageHands(cdp: CdpLike, sessionId: string) {
  await cdp.send('DOM.enable', {}, sessionId);
  const send = (method: string, params: object) => cdp.send(method, params, sessionId);

  /** The overlay's buttons now, found through its closed shadow root. */
  const buttons = async (): Promise<Array<{ node: DomNode; label: string }>> => {
    const { root } = (await send('DOM.getDocument', { depth: -1, pierce: true })) as {
      root: DomNode;
    };
    const found: Array<{ node: DomNode; label: string }> = [];
    walk(root, (n) => {
      if (n.nodeName !== 'BUTTON') return;
      const label = attr(n, 'aria-label') ?? textOf(n);
      if (
        attr(n, 'class') === 'dot' ||
        ['Pause', 'Resume', 'Mark', 'Stop', 'Start'].includes(label)
      ) {
        found.push({ node: n, label });
      }
    });
    return found;
  };

  const centre = async (nodeId: number): Promise<{ x: number; y: number }> => {
    const { model } = (await send('DOM.getBoxModel', { nodeId })) as {
      model: { content: number[] };
    };
    const q = model.content;
    return { x: ((q[0] ?? 0) + (q[4] ?? 0)) / 2, y: ((q[1] ?? 0) + (q[5] ?? 0)) / 2 };
  };

  const mouse = (type: string, x: number, y: number, extra: object = {}) =>
    send('Input.dispatchMouseEvent', { type, x, y, ...extra });

  return {
    hover: async (label: string) => {
      const hit = (await buttons()).find((b) => b.label === label);
      if (!hit) throw new Error(`no ${label} button`);
      const { x, y } = await centre(hit.node.nodeId);
      await mouse('mouseMoved', x, y);
    },
    click: async (label: string) => {
      const hit = (await buttons()).find((b) => b.label === label);
      if (!hit) throw new Error(`no ${label} button`);
      const { x, y } = await centre(hit.node.nodeId);
      await mouse('mouseMoved', x, y);
      await mouse('mousePressed', x, y, { button: 'left', clickCount: 1 });
      await mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 });
    },
    labels: async () => (await buttons()).map((b) => b.label),
    /** The Mark label box, when it is open. */
    labelBox: async (): Promise<DomNode | undefined> => {
      const { root } = (await send('DOM.getDocument', { depth: -1, pierce: true })) as {
        root: DomNode;
      };
      let box: DomNode | undefined;
      walk(root, (n) => {
        if (n.nodeName === 'INPUT' && attr(n, 'type') !== 'hidden') box = n;
      });
      return box;
    },
    /** Clicks into the label box, as a person would, so the keys go there however slow the page is. */
    clickLabelBox: async (): Promise<void> => {
      const { root } = (await send('DOM.getDocument', { depth: -1, pierce: true })) as {
        root: DomNode;
      };
      let box: DomNode | undefined;
      walk(root, (n) => {
        if (n.nodeName === 'INPUT' && attr(n, 'type') !== 'hidden') box = n;
      });
      if (!box) throw new Error('the label box is not open');
      const { x, y } = await centre(box.nodeId);
      await mouse('mouseMoved', x, y);
      await mouse('mousePressed', x, y, { button: 'left', clickCount: 1 });
      await mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 });
    },
  };
}

describe.runIf(exe)('the overlay, with a real mouse', () => {
  let zoo: Zoo;
  let run: BrowserRun | undefined;
  beforeAll(async () => {
    zoo = (await startZoo()) as Zoo;
  });
  afterAll(async () => {
    run?.kill();
    await zoo.close();
  }, 60_000);

  const start = async (): Promise<
    ReturnType<typeof pageHands> extends Promise<infer H> ? H : never
  > => {
    run = await startRecording({
      url: zoo.url('worker-and-iframe'),
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
    const hands = await pageHands(run.cdp, run.pageSession);
    await until(async () => (await hands.labels()).length > 0, 'the overlay to appear');
    return hands;
  };

  it('pauses when the Pause button is clicked, and resumes when Resume is', async () => {
    const hands = await start();
    await hands.hover('paces: recording');
    await until(async () => (await hands.labels()).includes('Pause'), 'the overlay to expand');
    await pressUntil(
      () => hands.click('Pause'),
      () => run?.controller.state().phase === 'paused',
      'the recording to pause',
    );
    await until(async () => (await hands.labels()).includes('Resume'), 'the Resume button');
    await pressUntil(
      () => hands.click('Resume'),
      () => run?.controller.state().phase === 'recording',
      'the recording to resume',
    );
    await run?.stop();
    const recording = await run?.done;
    expect(recording?.segments).toHaveLength(2);
  }, 90_000);
});
